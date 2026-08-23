import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ErrorCode } from '@casino/contracts';
import { PG_POOL } from '../platform/database/database.module';
import { withTransaction } from '../platform/database/transaction';
import { AuditService } from '../platform/audit/audit.service';
import { AuthRepository } from '../auth/auth.repository';
import { DomainError } from '../platform/errors/domain-error';
import { detectChipDumping, detectCoSeating, pairFlows, type HandSummary } from './collusion';
import { RiskRepository } from './risk.repository';
import {
  FROZEN_MESSAGE,
  RISK_ALLOWED,
  RISK_THRESHOLDS,
  type RiskAction,
  type RiskGate,
  type RiskRule,
  type RiskScore,
  type RiskSignal,
} from './risk.types';

export class RiskBlockedError extends DomainError {
  constructor(frozen: boolean, reason: string) {
    super(
      frozen ? ErrorCode.RISK_ACCOUNT_FROZEN : ErrorCode.RISK_RESTRICTED,
      reason,
      403,
    );
  }
}

/** How long a graduated restriction stands before it lapses on its own. */
const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The risk engine (`docs/02-domains/fraud-risk.md`, ADR-018).
 *
 * Signals in, scores and actions out. Three properties are worth stating because they are
 * the ones that would be quietly lost first:
 *
 * **Emitters report facts, never weights.** A signal carries what happened; `risk.rules`
 * decides what it is worth. Otherwise a compromised client could tell the server how much
 * to care about what it says — and the clients reporting hardening signals are exactly the
 * ones that might be compromised.
 *
 * **Client-only evidence can never freeze an account.** Not by policy but by arithmetic:
 * freezing is decided on the server-observed part of the score alone. A rooted phone is not
 * proof of fraud, and a hard block on one is an oracle telling an attacker which check to
 * defeat next.
 *
 * **No freeze without a case.** Every freeze opens one, and the refusal the player sees
 * names the support path. Silent freezes are the failure mode that turns a false positive
 * into somebody's money disappearing with nobody to ask.
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  private rules: Map<string, RiskRule> | null = null;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repository: RiskRepository,
    private readonly audit: AuditService,
    private readonly accounts: AuthRepository,
  ) {}

  // --- ingestion -----------------------------------------------------------

  /**
   * Records a signal and re-evaluates the subject.
   *
   * An unknown type is dropped rather than given a guessed weight: a signal nobody has
   * assigned meaning to has no meaning, and inventing one at ingest is how a typo becomes
   * a restriction.
   */
  async ingest(signal: RiskSignal, client?: PoolClient): Promise<void> {
    const rule = (await this.ruleSet()).get(signal.type);
    if (!rule || !rule.enabled) {
      this.logger.debug(`ignoring unknown or disabled signal type "${signal.type}"`);
      return;
    }

    await this.repository.recordSignal(
      {
        userId: signal.userId ?? null,
        sessionId: signal.sessionId ?? null,
        deviceId: signal.deviceId ?? null,
        matchId: signal.matchId ?? null,
        source: signal.source,
        type: signal.type,
        payload: signal.payload ?? {},
        weight: rule.weight,
        clientOnly: rule.clientOnly,
        ttlSeconds: rule.ttlSeconds,
      },
      client,
    );

    // Evaluation happens outside the caller's transaction on purpose: a signal is evidence
    // and must be recorded even if acting on it fails, and acting on it must not be able
    // to roll back the thing that reported it.
    if (signal.userId) void this.evaluate(signal.userId).catch((error) => {
      this.logger.error(
        `risk evaluation failed for ${signal.userId}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    });
  }

  // --- scoring -------------------------------------------------------------

  async scoreFor(userId: string): Promise<RiskScore> {
    const signals = await this.repository.liveSignals(userId);

    let total = 0;
    let serverEvidence = 0;
    for (const signal of signals) {
      total += signal.weight;
      if (!signal.clientOnly) serverEvidence += signal.weight;
    }

    return {
      userId,
      total,
      serverEvidence,
      contributing: signals.map((signal) => ({
        type: signal.type,
        weight: signal.weight,
        clientOnly: signal.clientOnly,
        at: signal.createdAt,
      })),
    };
  }

  /**
   * Re-scores a user and applies the highest rung they have reached.
   *
   * Freezing is the only rung decided on `serverEvidence` rather than the total. That one
   * line is the normative "client signals never freeze" rule — and the seeded weights are
   * chosen so that even the total of every client-only signal falls short of the freeze
   * threshold, so the rule survives an unwise edit to either.
   */
  async evaluate(userId: string): Promise<{ score: RiskScore; applied: RiskAction | null }> {
    const score = await this.scoreFor(userId);

    const rung: RiskAction | null =
      score.serverEvidence >= RISK_THRESHOLDS.freeze
        ? 'freeze'
        : score.total >= RISK_THRESHOLDS.requireReview
          ? 'require_review'
          : score.total >= RISK_THRESHOLDS.limit
            ? 'limit'
            : score.total >= RISK_THRESHOLDS.flag
              ? 'flag'
              : null;

    if (!rung) return { score, applied: null };

    // Cheap check outside the lock, to keep the common case — a rung that already stands —
    // from queueing behind other evaluations. It is not the one that decides: `applyAction`
    // re-reads under the lock, because this read can be stale by the time it returns.
    const existing = await this.repository.activeActions(userId);
    if (existing.some((action) => action.action === rung)) return { score, applied: null };

    const applied = await this.applyAction(userId, rung, score);
    return { score, applied: applied ? rung : null };
  }

  /** Returns whether it applied — `false` means another evaluation got there first. */
  private async applyAction(
    userId: string,
    action: RiskAction,
    score: RiskScore,
  ): Promise<boolean> {
    const evidence = {
      total: score.total,
      serverEvidence: score.serverEvidence,
      signals: score.contributing.map((entry) => ({ type: entry.type, weight: entry.weight })),
    };

    const applied = await withTransaction(this.pool, async (client) => {
      // Everything from here to the commit is one decision about one user (see
      // `lockUser`), including the re-read that decides whether to make it at all.
      await this.repository.lockUser(client, userId);

      const standing = await this.repository.activeActions(userId, client);
      if (standing.some((entry) => entry.action === action)) return false;

      await this.repository.applyAction(client, {
        userId,
        action,
        reason: `risk score ${score.total} (server evidence ${score.serverEvidence})`,
        evidence,
        // A freeze stands until a human lifts it; the softer rungs lapse on their own so a
        // one-off does not follow someone around forever.
        expiresAt: action === 'freeze' ? null : new Date(Date.now() + ACTION_TTL_MS),
      });

      if (action === 'freeze') {
        // The account state moves in the same transaction as the action, and a case opens
        // with it. There is no ordering in which a frozen player has no case to point at.
        await this.accounts.setUserStatus(client, userId, 'suspended');
        await this.repository.openCase(client, {
          userId,
          reason: 'account frozen by the risk engine',
          evidence,
          priority: 'high',
        });
      }

      await this.audit.append(
        {
          actorType: 'system',
          action: `risk.${action}`,
          subjectRef: userId,
          payload: evidence,
        },
        client,
      );

      return true;
    });

    if (applied) {
      this.logger.warn(`risk applied ${action} to ${userId} (score ${score.total})`);
    }
    return applied;
  }

  // --- enforcement ---------------------------------------------------------

  /**
   * May this user move money?
   *
   * Consulted from the wallet, so a restriction binds on every path at once rather than
   * on the ones somebody remembered (ADR-026).
   */
  async gate(userId: string): Promise<RiskGate> {
    const actions = await this.repository.activeActions(userId);
    if (actions.length === 0) return RISK_ALLOWED;

    if (actions.some((entry) => entry.action === 'freeze')) {
      return { allowed: false, action: 'freeze', reason: FROZEN_MESSAGE };
    }
    if (actions.some((entry) => entry.action === 'limit')) {
      return {
        allowed: false,
        action: 'limit',
        reason: 'Some account activity is limited while we check a few things.',
      };
    }

    // `flag` and `require_review` are visible to review, not to the player. Degrading
    // silently is deliberate: an attacker who can see which rung they are on can binary-
    // search the rules (`fraud-risk.md §6`).
    return RISK_ALLOWED;
  }

  async requireAllowed(userId: string): Promise<void> {
    const gate = await this.gate(userId);
    if (!gate.allowed) throw new RiskBlockedError(gate.action === 'freeze', gate.reason!);
  }

  // --- identity graph ------------------------------------------------------

  /**
   * Records that a session used this device and address, and scores what that implies.
   *
   * Called on login. Shared devices are the strongest cheap multi-accounting signal there
   * is; shared addresses are the weakest, because a coffee shop and a carrier NAT look
   * exactly like a fraud ring from here — which is why the threshold is far higher and the
   * weight far lower.
   */
  async observeSession(input: { userId: string; deviceId?: string; ip?: string }): Promise<void> {
    try {
      if (input.deviceId) {
        await this.repository.linkDevice(input.deviceId, input.userId);
        const accounts = await this.repository.accountsOnDevice(input.deviceId);
        if (accounts.length >= 3) {
          await this.ingest({
            source: 'auth',
            type: 'identity.device_shared',
            userId: input.userId,
            deviceId: input.deviceId,
            payload: { accounts: accounts.length },
          });
        }
      }

      if (input.ip) {
        await this.repository.linkIp(input.ip, input.userId);
        const accounts = await this.repository.accountsOnIp(input.ip);
        // Deliberately high: shared addresses are the norm on mobile networks.
        if (accounts.length >= 8) {
          await this.ingest({
            source: 'auth',
            type: 'identity.ip_shared',
            userId: input.userId,
            payload: { accounts: accounts.length },
          });
        }
      }
    } catch (error) {
      // Risk observation must never be able to fail a login. Losing a graph edge costs a
      // little detection; failing the login costs the player their session.
      this.logger.warn(
        `session observation failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  // --- gameplay ------------------------------------------------------------

  /**
   * Records how chips moved in a finished hand, and looks for a pattern.
   *
   * Poker pushes this in rather than risk reading `poker.hands` (rule 20). The summary is
   * stored as a zero-weight signal — a fact, not a judgement, because playing poker is not
   * evidence of anything — and the heuristics run over the recent history of the players
   * involved.
   *
   * A finding corroborated by the identity graph is scored under a different rule
   * entirely: a one-sided flow between strangers is odd, and the same flow between two
   * accounts that have shared a device is most of a case.
   */
  async observePokerHand(input: {
    matchId: string;
    tableId: string;
    net: Record<string, number>;
  }): Promise<void> {
    const players = Object.keys(input.net);
    if (players.length < 2) return;

    try {
      for (const userId of players) {
        await this.repository.recordSignal({
          userId,
          matchId: input.matchId,
          source: 'poker',
          type: 'gameplay.hand_summary',
          payload: { tableId: input.tableId, net: input.net },
          weight: 0,
          clientOnly: false,
          ttlSeconds: 30 * 24 * 60 * 60,
        });
      }

      await this.reviewGameplay(players);
    } catch (error) {
      // A hand must settle whether or not it can be scored.
      this.logger.warn(
        `poker hand observation failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /** Runs the collusion heuristics over the recent history of these players. */
  private async reviewGameplay(players: readonly string[]): Promise<void> {
    const summaries: HandSummary[] = [];
    const seen = new Set<string>();
    const handsPerPlayer: Record<string, number> = {};

    for (const userId of players) {
      const recent = await this.repository.recentSignalsOfType('gameplay.hand_summary', userId, 200);
      handsPerPlayer[userId] = recent.length;

      for (const entry of recent) {
        const net = entry.payload.net as Record<string, number> | undefined;
        const tableId = String(entry.payload.tableId ?? '');
        if (!net) continue;

        // The same hand appears once per participant; count it once.
        const key = `${tableId}:${entry.createdAt.getTime()}:${Object.keys(net).sort().join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        summaries.push({ matchId: key, tableId, net, at: entry.createdAt });
      }
    }

    const flows = pairFlows(summaries);

    for (const finding of detectChipDumping(flows)) {
      const linked = await this.repository.shareADevice(finding.from, finding.to);
      for (const userId of [finding.from, finding.to]) {
        await this.ingest({
          source: 'poker',
          type: linked ? 'gameplay.chip_dump_linked' : 'gameplay.chip_dump',
          userId,
          payload: {
            counterparty: userId === finding.from ? finding.to : finding.from,
            netChips: finding.netChips,
            handsTogether: finding.handsTogether,
            asymmetry: Number(finding.asymmetry.toFixed(3)),
            linkedByDevice: linked,
          },
        });
      }
    }

    for (const finding of detectCoSeating(flows, handsPerPlayer)) {
      for (const userId of [finding.a, finding.b]) {
        await this.ingest({
          source: 'poker',
          type: 'gameplay.collusion_coseating',
          userId,
          payload: {
            counterparty: userId === finding.a ? finding.b : finding.a,
            share: Number(finding.share.toFixed(3)),
            handsTogether: finding.handsTogether,
          },
        });
      }
    }
  }

  // --- reads ---------------------------------------------------------------

  async statusFor(userId: string): Promise<Record<string, unknown>> {
    const [score, actions, cases] = await Promise.all([
      this.scoreFor(userId),
      this.repository.activeActions(userId),
      this.repository.openCasesFor(userId),
    ]);

    return {
      score: score.total,
      serverEvidence: score.serverEvidence,
      actions: actions.map((entry) => entry.action),
      openCases: cases.length,
      contributing: score.contributing.map((entry) => ({ type: entry.type, weight: entry.weight })),
    };
  }

  /** Rules, cached in memory. Reloaded on demand so an edit does not need a deploy. */
  private async ruleSet(): Promise<Map<string, RiskRule>> {
    if (this.rules) return this.rules;
    const rules = await this.repository.listRules();
    this.rules = new Map(rules.map((rule) => [rule.type, rule]));
    return this.rules;
  }

  /** Drops the rule cache — for an admin edit (P12) and for tests. */
  invalidateRules(): void {
    this.rules = null;
  }
}
