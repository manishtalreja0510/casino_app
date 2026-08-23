import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../platform/database/database.module';
import { withTransaction } from '../platform/database/transaction';
import { AuditService } from '../platform/audit/audit.service';
import { AuthRepository } from '../auth/auth.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { PresenceService } from '../realtime/presence.service';
import { Rooms } from '../realtime/realtime.types';
import { RgRepository } from './rg.repository';
import { RgBlockedError, RgInvalidLimitError } from './rg.errors';
import {
  LIMIT_INCREASE_COOLING_MS,
  REALITY_CHECK_GRACE_MS,
  REALITY_CHECK_MAX_MS,
  REALITY_CHECK_MIN_MS,
  RG_ALLOWED,
  periodLabel,
  typesFor,
  type ExclusionKind,
  type LimitPeriod,
  type LimitType,
  type RgDecision,
  type SpendKind,
} from './rg.types';

/**
 * Responsible gaming (`docs/02-domains/responsible-gaming.md`).
 *
 * The normative invariant this module exists to keep: **RG blocks are enforced server-side
 * and cannot be bypassed by any client or game code path.** That is why `checkAllowance`
 * takes a transaction client and is called from inside the wallet's debit paths rather than
 * from each game — a check a caller must remember is a check somebody will eventually
 * forget, in a game written long after this was written (ADR-026).
 *
 * Two things are deliberately asymmetric, and both are standard regulatory patterns:
 * a player may always tighten immediately and must wait to loosen, and an exclusion can be
 * extended but never shortened — not by an admin, not by a superadmin. The second is
 * enforced by a database trigger, because "we would never do that" is not a control.
 */
/** How often lapsed breaks are reconciled against account status. */
const LAPSE_SWEEP_MS = 60_000;

/** How often due reality checks are looked for. Finer than any interval a player can set. */
const REALITY_CHECK_SWEEP_MS = 30_000;

/** One tick, one minute of play. The interval *is* the unit — see `meterConnectedPlayTime`. */
const PLAY_TIME_SWEEP_MS = 60_000;

/** The event a reality check arrives as. Server-pushed; the client cannot ask for it. */
export const REALITY_CHECK_EVENT = 'rg:reality_check';

@Injectable()
export class RgService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RgService.name);

  private lapseSweep?: ReturnType<typeof setInterval>;
  private realityCheckSweep?: ReturnType<typeof setInterval>;
  private playTimeSweep?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repository: RgRepository,
    private readonly audit: AuditService,
    private readonly accounts: AuthRepository,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
    private readonly presence: PresenceService,
  ) {}

  /**
   * Starts the lapse sweep, on the instances that run scheduled work.
   *
   * Nothing about *enforcement* waits for this: an exclusion binds and stops binding from
   * `rg.exclusions` alone, to the second. What the sweep fixes is the account status left
   * behind when a cool-off runs out, which no request would otherwise ever revisit. A
   * minute of lag on a label is fine; a permanent wrong label is not.
   */
  onApplicationBootstrap(): void {
    if (!this.config.get<boolean>('SCHEDULED_WORK_ENABLED', true)) {
      this.logger.log('lapse sweep disabled for this instance (SCHEDULED_WORK_ENABLED=false)');
      return;
    }
    this.lapseSweep = setInterval(() => void this.releaseLapsedExclusions(), LAPSE_SWEEP_MS);
    this.lapseSweep.unref?.();
    this.realityCheckSweep = setInterval(
      () => void this.dispatchRealityChecks(),
      REALITY_CHECK_SWEEP_MS,
    );
    this.realityCheckSweep.unref?.();
    this.playTimeSweep = setInterval(() => void this.meterConnectedPlayTime(), PLAY_TIME_SWEEP_MS);
    this.playTimeSweep.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.lapseSweep) clearInterval(this.lapseSweep);
    if (this.realityCheckSweep) clearInterval(this.realityCheckSweep);
    if (this.playTimeSweep) clearInterval(this.playTimeSweep);
  }

  /**
   * Pushes due reality checks to the players who are actually connected.
   *
   * Server-emitted, never requested: the client is told how long it has been playing
   * rather than asked to keep track, because a client that keeps track is a client that
   * can decide not to (`responsible-gaming.md §7`).
   *
   * Presence decides who gets one, and that is the important detail. Marking a check shown
   * starts a grace period after which play pauses — so marking one shown for a player who
   * was offline would greet them, on their return, with a block for a message they were
   * never sent. A check is shown to someone who is there to see it, or not at all.
   *
   * Returns the ids it delivered to, so a test and an operator can both see what it did.
   */
  async dispatchRealityChecks(): Promise<string[]> {
    const delivered: string[] = [];
    try {
      for (const due of await this.repository.dueRealityChecks()) {
        const present = await this.presence.members(Rooms.user(due.userId));
        if (present.length === 0) continue;

        // Skipped rather than replaced: a check already waiting for a tap does not need a
        // second one stacked behind it, and re-marking it shown would keep pushing the
        // grace period back for a player who is ignoring it.
        const check = await this.repository.realityCheck(due.userId);
        if (check.lastShownAt && !(check.lastAckAt && check.lastAckAt >= check.lastShownAt)) {
          continue;
        }

        const usage = await this.dayFigures(due.userId);
        await this.repository.markRealityCheckShown(due.userId);
        await this.realtime.toUser(due.userId, REALITY_CHECK_EVENT, {
          intervalMs: due.intervalMs,
          graceMs: REALITY_CHECK_GRACE_MS,
          ...usage,
        });
        await withTransaction(this.pool, (client) =>
          this.repository.recordEvent(client, {
            userId: due.userId,
            type: 'reality_check.shown',
            payload: usage,
          }),
        );
        delivered.push(due.userId);
      }
    } catch (error) {
      this.logger.warn(
        `reality check sweep failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    return delivered;
  }

  /** What the check tells the player: today's figures, in minor units. */
  private async dayFigures(userId: string): Promise<{ staked: number; net: number }> {
    const at = new Date();
    const [wagered, loss] = await withTransaction(this.pool, async (client) => [
      await this.repository.usageFor(client, userId, 'wager', 'day', at),
      await this.repository.usageFor(client, userId, 'loss', 'day', at),
    ]);
    return { staked: wagered.spent, net: loss.returned - loss.spent };
  }

  /**
   * Returns accounts to `active` whose break has run out.
   *
   * Public so a test — and, later, an operator runbook — can run it on demand rather than
   * waiting for the interval. Failures are logged and swallowed: this is reconciliation,
   * and a database hiccup must not take the process down with it.
   */
  async releaseLapsedExclusions(): Promise<string[]> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const released = await this.repository.releaseLapsedExclusions(client);
        for (const userId of released) {
          await this.repository.recordEvent(client, { userId, type: 'exclusion.lapsed' });
        }
        if (released.length > 0) {
          this.logger.log(`${released.length} exclusion(s) lapsed; accounts reactivated`);
        }
        return released;
      });
    } catch (error) {
      this.logger.warn(
        `lapse sweep failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return [];
    }
  }

  // --- enforcement ---------------------------------------------------------

  /**
   * May this player spend `amount` on an operation of this kind?
   *
   * Called **inside the transaction that commits the spend**, so the usage it reads cannot
   * be stale and the usage it writes cannot outlive a rollback. Returns a decision rather
   * than throwing: the wallet turns it into an error, and other callers (a lobby preview,
   * say) want to render it instead.
   */
  async checkAllowance(
    client: PoolClient,
    input: { userId: string; kind: SpendKind; amount: number; at?: Date },
  ): Promise<RgDecision> {
    const at = input.at ?? new Date();

    const exclusion = await this.repository.activeExclusion(input.userId, client);
    if (exclusion) {
      const until = exclusion.endsAt ? ` until ${exclusion.endsAt.toISOString().slice(0, 10)}` : '';
      return {
        allowed: false,
        reason:
          exclusion.kind === 'self_exclusion'
            ? `You are self-excluded${until}. Support can explain your options.`
            : `You are taking a break${until}.`,
      };
    }

    // A pending increase whose time has come binds now, not whenever a sweep runs.
    await this.repository.promoteDueIncreases(client, input.userId);

    const limits = await this.repository.listLimits(input.userId, client);
    const applicable = limits.filter((limit) => typesFor(input.kind).includes(limit.type));

    for (const limit of applicable) {
      const usage = await this.repository.usageFor(client, input.userId, limit.type, limit.period, at);

      // A wager limit meters what goes out. A loss limit meters what went out minus what
      // came back — one subtraction rather than a second counter that can disagree with
      // the first.
      const used =
        limit.type === 'loss' ? Math.max(0, usage.spent - usage.returned) : usage.spent;

      if (used + input.amount > limit.amount) {
        return {
          allowed: false,
          reason: `That would pass your ${periodLabel(limit.period)} ${limit.type.replace('_', ' ')} limit.`,
          limit: { type: limit.type, period: limit.period, amount: limit.amount, used },
        };
      }
    }

    return RG_ALLOWED;
  }

  /**
   * Records a spend against every limit type it counts toward.
   *
   * Separate from the check, and always called in the same transaction as the money — a
   * spend that committed without being metered is a limit that silently stops working.
   */
  async meterSpend(
    client: PoolClient,
    input: { userId: string; kind: SpendKind; amount: number; at?: Date },
  ): Promise<void> {
    const at = input.at ?? new Date();
    for (const type of typesFor(input.kind)) {
      for (const period of ['day', 'week', 'month'] as LimitPeriod[]) {
        await this.repository.meter(client, {
          userId: input.userId,
          type,
          period,
          at,
          spent: input.amount,
        });
      }
    }
  }

  /** Records money coming back — what makes a loss limit a net figure. */
  async meterReturn(
    client: PoolClient,
    input: { userId: string; amount: number; at?: Date },
  ): Promise<void> {
    const at = input.at ?? new Date();
    for (const period of ['day', 'week', 'month'] as LimitPeriod[]) {
      await this.repository.meter(client, {
        userId: input.userId,
        type: 'loss',
        period,
        at,
        returned: input.amount,
      });
    }
  }

  /**
   * May this player *start* something new — join a queue, sit at a table, open a round?
   *
   * Distinct from `checkAllowance` because it also enforces the reality check, which
   * pauses **new** play and never interrupts a hand in progress. A player mid-hand is
   * finishing something they already committed chips to; blocking that would be a worse
   * outcome than the one the check exists to prevent.
   */
  async checkPlayEntry(userId: string): Promise<RgDecision> {
    const exclusion = await this.repository.activeExclusion(userId);
    if (exclusion) {
      return {
        allowed: false,
        reason:
          exclusion.kind === 'self_exclusion'
            ? 'You are self-excluded from play.'
            : 'You are taking a break from play.',
      };
    }

    // Time played today, against a limit the player set on it. Checked at *entry* — a
    // player mid-hand is finishing something they already committed chips to, and the
    // limit is about how long they sit down for, not about taking a pot away from them.
    const overTime = await this.exhaustedSessionTime(userId);
    if (overTime) {
      return {
        allowed: false,
        reason: `You have reached your ${periodLabel(overTime.period)} time limit of ` +
          `${overTime.amount} minutes.`,
        limit: overTime,
      };
    }

    const check = await this.repository.realityCheck(userId);
    if (check.lastShownAt) {
      const acknowledged = check.lastAckAt && check.lastAckAt >= check.lastShownAt;
      const overdue = Date.now() - check.lastShownAt.getTime() > REALITY_CHECK_GRACE_MS;
      if (!acknowledged && overdue) {
        return { allowed: false, reason: 'Please acknowledge your reality check to keep playing.' };
      }
    }

    return RG_ALLOWED;
  }

  /**
   * The session-time limit this player has already used up, if any.
   *
   * Returns the limit rather than a boolean, so the refusal can say which one and for how
   * long — "you have reached your limit" without saying which limit is a message that
   * sends people to support.
   */
  private async exhaustedSessionTime(
    userId: string,
  ): Promise<{ type: LimitType; period: LimitPeriod; amount: number; used: number } | null> {
    return withTransaction(this.pool, async (client) => {
      const limits = (await this.repository.listLimits(userId, client)).filter(
        (limit) => limit.type === 'session_time',
      );
      const at = new Date();

      for (const limit of limits) {
        const usage = await this.repository.usageFor(client, userId, 'session_time', limit.period, at);
        if (usage.spent >= limit.amount) {
          return { type: limit.type, period: limit.period, amount: limit.amount, used: usage.spent };
        }
      }
      return null;
    });
  }

  /**
   * Meters a minute of play against everyone who is connected.
   *
   * Presence is what defines "playing": a socket on the `/game` namespace is a player at a
   * table or in a round, and a player reading their wallet holds no socket (P8). It is a
   * coarse measure and deliberately so — the alternative, threading a stopwatch through
   * every game, is a per-game rule that a new game would forget, which is precisely the
   * failure ADR-026 exists to avoid.
   *
   * A whole minute per tick, and the tick is a minute: no fractions to round, and the
   * worst case is under-counting a player's first minute. Under-counting is the right
   * direction to be wrong in for a limit the *player* set on themselves, because the cost
   * of over-counting is cutting somebody off early for time they never played.
   */
  async meterConnectedPlayTime(): Promise<number> {
    try {
      const users = await this.presence.connectedUsers();
      if (users.length === 0) return 0;

      const at = new Date();
      await withTransaction(this.pool, async (client) => {
        for (const userId of users) {
          for (const period of ['day', 'week', 'month'] as LimitPeriod[]) {
            await this.repository.meter(client, {
              userId,
              type: 'session_time',
              period,
              at,
              spent: 1,
            });
          }
        }
      });
      return users.length;
    } catch (error) {
      this.logger.warn(
        `session-time sweep failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return 0;
    }
  }

  /** Throwing wrappers, for callers whose only sensible response is to refuse. */
  async requireAllowance(
    client: PoolClient,
    input: { userId: string; kind: SpendKind; amount: number },
  ): Promise<void> {
    const decision = await this.checkAllowance(client, input);
    if (!decision.allowed) {
      const excluded = decision.reason?.includes('excluded') || decision.reason?.includes('break');
      throw excluded
        ? RgBlockedError.excluded(decision.reason!)
        : new RgBlockedError(decision.reason ?? 'Not allowed right now');
    }
  }

  async requirePlayEntry(userId: string): Promise<void> {
    const decision = await this.checkPlayEntry(userId);
    if (!decision.allowed) {
      const isCheck = decision.reason?.includes('reality check');
      throw isCheck
        ? RgBlockedError.realityCheck(decision.reason!)
        : RgBlockedError.excluded(decision.reason ?? 'Not allowed right now');
    }
  }

  /** Whether the player is excluded right now — for read surfaces and auth. */
  async isExcluded(userId: string): Promise<boolean> {
    return (await this.repository.activeExclusion(userId)) !== null;
  }

  // --- player controls -----------------------------------------------------

  async setLimit(input: {
    userId: string;
    type: LimitType;
    period: LimitPeriod;
    amount: number;
  }): Promise<{ effective: 'immediate' | 'pending'; effectiveAt: Date | null }> {
    if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
      throw new RgInvalidLimitError('A limit has to be a whole, non-negative number.');
    }

    return withTransaction(this.pool, async (client) => {
      const result = await this.repository.setLimit(client, {
        ...input,
        coolingMs: LIMIT_INCREASE_COOLING_MS,
      });

      await this.repository.recordEvent(client, {
        userId: input.userId,
        type: result.effective === 'immediate' ? 'limit.set' : 'limit.increase_requested',
        payload: {
          limitType: input.type,
          period: input.period,
          amount: input.amount,
          ...(result.effectiveAt ? { effectiveAt: result.effectiveAt.toISOString() } : {}),
        },
      });

      await this.audit.append(
        {
          actorType: 'user',
          actorId: input.userId,
          action: 'rg.limit_set',
          payload: { limitType: input.type, period: input.period, effective: result.effective },
        },
        client,
      );

      return result;
    });
  }

  async cancelPendingIncrease(userId: string, type: LimitType, period: LimitPeriod): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await this.repository.cancelPending(client, userId, type, period);
      await this.repository.recordEvent(client, {
        userId,
        type: 'limit.increase_cancelled',
        payload: { limitType: type, period },
      });
    });
  }

  /**
   * Starts a cool-off or a self-exclusion.
   *
   * Immediate and one-way. The account state changes in the same transaction, so there is
   * no window in which the exclusion exists but does not bind — and the caller is expected
   * to have already made the player confirm, because this cannot be undone by anyone.
   */
  async exclude(input: {
    userId: string;
    kind: ExclusionKind;
    durationMs: number | null;
    source?: string;
  }): Promise<{ endsAt: Date | null }> {
    if (input.durationMs !== null && input.durationMs <= 0) {
      throw new RgInvalidLimitError('A break has to last a positive amount of time.');
    }
    if (input.kind === 'cool_off' && input.durationMs === null) {
      throw new RgInvalidLimitError('A cool-off has an end; a permanent break is self-exclusion.');
    }

    const endsAt = input.durationMs === null ? null : new Date(Date.now() + input.durationMs);

    return withTransaction(this.pool, async (client) => {
      await this.repository.addExclusion(client, {
        userId: input.userId,
        kind: input.kind,
        endsAt,
        ...(input.source ? { source: input.source } : {}),
      });

      // The account state moves with it, inside the same transaction. Otherwise there is a
      // window — however short — where the record exists and the block does not.
      //
      // The state is `self_excluded` for both kinds: a cool-off is a self-exclusion with a
      // near end date, and giving it a separate state would mean every enforcement point
      // had two things to remember instead of one.
      await this.accounts.setUserStatus(client, input.userId, 'self_excluded');

      await this.repository.recordEvent(client, {
        userId: input.userId,
        type: input.kind === 'cool_off' ? 'cool_off.started' : 'self_exclusion.started',
        payload: { endsAt: endsAt?.toISOString() ?? null },
      });

      await this.audit.append(
        {
          actorType: input.source === 'player' || !input.source ? 'user' : 'admin',
          actorId: input.userId,
          action: `rg.${input.kind}`,
          payload: { endsAt: endsAt?.toISOString() ?? null },
        },
        client,
      );

      this.logger.log(`user ${input.userId} started a ${input.kind}`);
      return { endsAt };
    });
  }

  async setRealityCheckInterval(userId: string, intervalMs: number): Promise<void> {
    if (intervalMs < REALITY_CHECK_MIN_MS || intervalMs > REALITY_CHECK_MAX_MS) {
      throw new RgInvalidLimitError(
        `A reality check can be set between ${REALITY_CHECK_MIN_MS / 60000} and ` +
          `${REALITY_CHECK_MAX_MS / 60000} minutes.`,
      );
    }
    await withTransaction(this.pool, async (client) => {
      await this.repository.setRealityCheckInterval(client, userId, intervalMs);
      await this.repository.recordEvent(client, {
        userId,
        type: 'reality_check.interval_set',
        payload: { intervalMs },
      });
    });
  }

  /** Whether a reality check is due, and marking it shown. Called by the play surfaces. */
  async realityCheckDue(userId: string): Promise<boolean> {
    const check = await this.repository.realityCheck(userId);
    if (!check.lastShownAt) return true;
    return Date.now() - check.lastShownAt.getTime() >= check.intervalMs;
  }

  async markRealityCheckShown(userId: string): Promise<void> {
    await this.repository.markRealityCheckShown(userId);
  }

  async acknowledgeRealityCheck(userId: string): Promise<void> {
    await this.repository.acknowledgeRealityCheck(userId);
    await withTransaction(this.pool, (client) =>
      this.repository.recordEvent(client, { userId, type: 'reality_check.acknowledged' }),
    );
  }

  // --- reads ---------------------------------------------------------------

  /** Everything the player's RG screen renders. */
  async statusFor(userId: string): Promise<Record<string, unknown>> {
    const at = new Date();
    const [limits, exclusion, exclusions, check, events] = await Promise.all([
      this.repository.listLimits(userId),
      this.repository.activeExclusion(userId),
      this.repository.listExclusions(userId),
      this.repository.realityCheck(userId),
      this.repository.listEvents(userId, 25),
    ]);

    const withUsage = await withTransaction(this.pool, async (client) => {
      const out = [];
      for (const limit of limits) {
        const usage = await this.repository.usageFor(client, userId, limit.type, limit.period, at);
        out.push({
          type: limit.type,
          period: limit.period,
          amount: limit.amount,
          used: limit.type === 'loss' ? Math.max(0, usage.spent - usage.returned) : usage.spent,
          pendingAmount: limit.pendingAmount,
          pendingEffectiveAt: limit.pendingEffectiveAt?.toISOString() ?? null,
        });
      }
      return out;
    });

    return {
      limits: withUsage,
      exclusion: exclusion
        ? {
            kind: exclusion.kind,
            startsAt: exclusion.startsAt.toISOString(),
            endsAt: exclusion.endsAt?.toISOString() ?? null,
          }
        : null,
      history: exclusions.map((entry) => ({
        kind: entry.kind,
        startsAt: entry.startsAt.toISOString(),
        endsAt: entry.endsAt?.toISOString() ?? null,
      })),
      realityCheck: {
        intervalMs: check.intervalMs,
        lastShownAt: check.lastShownAt?.toISOString() ?? null,
        acknowledged: !check.lastShownAt || (check.lastAckAt ?? new Date(0)) >= check.lastShownAt,
      },
      events: events.map((event) => ({
        type: event.type,
        payload: event.payload,
        at: event.createdAt.toISOString(),
      })),
    };
  }
}
