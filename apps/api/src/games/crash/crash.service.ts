import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { CrashEvent, crashRoundRoom, type CrashRoundPublic } from '@casino/contracts';
import { FlagsService } from '../../platform/flags/flags.service';
import { gameEnabledKey } from '../../platform/flags/flag-keys';
import { EngineService, type MatchChange } from '../../game-engine/engine.service';
import { MatchRepository, type MatchRow } from '../../game-engine/match.repository';
import { MatchmakingRepository, type StakeTier } from '../../matchmaking/matchmaking.repository';
import { RealtimeService } from '../../realtime/realtime.service';
import { TimerService } from '../../realtime/timer.service';
import { WalletService } from '../../wallet/wallet.service';
import { RgService } from '../../responsible-gaming/rg.service';
import { RoundLeaderService } from './round-leader.service';
import { parseCrashConfig, type CrashConfig } from './crash.config';
import { BASE_X100, GROWTH_PER_MILLE, TICK_MS, commitmentFor } from './crash.math';
import { crash } from './crash.game';
import {
  BetOutOfBoundsError,
  CrashTierUnavailableError,
  InvalidAutoCashOutError,
  NoOpenRoundError,
  RoundLimitReachedError,
} from './crash.errors';

export const CRASH_GAME_CODE = 'crash';

/** How often the watchdog looks for a tier that has no round running. */
const WATCHDOG_MS = 5_000;

/** Outcomes kept per tier for the history strip. Cosmetic — see `recentOutcomes`. */
const HISTORY_LENGTH = 20;

/**
 * The round loop (`docs/02-domains/casino-game.md §2`).
 *
 * Everything about a Crash round that is *not* game logic lives here: when a round opens,
 * who may bet into it, when betting closes, and what the shared room is told. The rules
 * themselves are in `crash.game.ts` and cannot reach any of this — the reducer has no idea
 * a round loop exists, which is what keeps it replayable.
 *
 * The loop is deliberately not the source of truth for anything. A round's existence, its
 * roster and its money are rows in PostgreSQL; this service can be restarted, moved to
 * another instance, or run late, and the worst that happens is a gap between rounds.
 */
@Injectable()
export class CrashService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CrashService.name);

  private watchdog?: NodeJS.Timeout;
  private stopping = false;

  /**
   * Last outcomes per tier, for the history strip.
   *
   * In memory on purpose: it is decoration, it is rebuilt as rounds run, and a strip that
   * starts empty after a deploy is not worth a table. Anything a dispute could turn on is
   * in the event log, which is durable.
   */
  private readonly history = new Map<string, Array<{ matchId: string; crashedAtX100: number }>>();

  constructor(
    private readonly engine: EngineService,
    private readonly matches: MatchRepository,
    private readonly tiers: MatchmakingRepository,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeService,
    private readonly timers: TimerService,
    private readonly flags: FlagsService,
    private readonly leader: RoundLeaderService,
    private readonly config: ConfigService,
    private readonly rg: RgService,
  ) {}

  onApplicationBootstrap(): void {
    // Registered whether or not this instance drives rounds: an instance that merely
    // serves bets still has to tell its room what happened to a round it is watching.
    this.engine.onMatchChanged((change) => this.onMatchChanged(change));

    if (!this.config.get<boolean>('SCHEDULED_WORK_ENABLED', true)) {
      this.logger.log('round loop disabled for this instance (SCHEDULED_WORK_ENABLED=false)');
      return;
    }

    // A watchdog rather than a strict schedule. Every path that should open the next round
    // also does so directly; this exists so that a missed one — a lost lease, a restart
    // mid-window, an exception — costs a few seconds instead of stopping the game.
    this.watchdog = setInterval(() => void this.sweep(), WATCHDOG_MS);
    this.watchdog.unref?.();
    void this.sweep();
  }

  onApplicationShutdown(): void {
    this.stopping = true;
    if (this.watchdog) clearInterval(this.watchdog);
  }

  /** Ensures every enabled Crash tier has a round, if this instance is the one driving it. */
  async sweep(): Promise<void> {
    if (this.stopping) return;
    try {
      const tiers = await this.tiers.listTiers(CRASH_GAME_CODE);
      for (const tier of tiers) await this.ensureRound(tier);
    } catch (error) {
      this.logger.warn(
        `crash sweep failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /**
   * Makes sure `tier` has exactly one round in progress.
   *
   * The kill-switch is checked here and nowhere else in the loop, which is what makes it a
   * **drain** rather than a cut (rule 16): a round already open keeps its betting window,
   * flies, crashes and settles normally; only the next one fails to appear. Pulling the
   * switch never strands a stake in escrow.
   */
  private async ensureRound(tier: StakeTier): Promise<void> {
    if (!(await this.leader.acquire(`crash:${tier.id}`))) return;

    const active = await this.matches.findActiveRound(CRASH_GAME_CODE, tier.id);

    if (active) {
      // A round that was open when the process died (or when leadership moved) still has a
      // betting window on the clock but no timer behind it. Re-arm it from the deadline
      // recorded in its config.
      if (active.status === 'created') this.armBettingClose(active, tier);
      return;
    }

    if (!(await this.flags.isEnabled(gameEnabledKey(CRASH_GAME_CODE)))) return;
    await this.openRound(tier);
  }

  /**
   * Opens a round: a match with no players, a committed outcome, and a betting window.
   *
   * The seed is generated and hashed **before anyone can bet**, and the hash is what the
   * room is told. That ordering is the entire provable-fairness claim: the outcome exists,
   * unchangeable, before the first stake.
   */
  private async openRound(tier: StakeTier): Promise<void> {
    const { config, error } = parseCrashConfig(tier.config);
    if (error) {
      // Fall back to the zero-stake configuration rather than guessing limits — but say so
      // loudly, because a tier that silently became free play is an operational problem.
      this.logger.error(`tier ${tier.id} has invalid crash config (${error}); running free play`);
    }

    const serverSeed = randomBytes(32).toString('hex');
    const commitment = commitmentFor(serverSeed);
    const betsCloseAt = Date.now() + config.bettingWindowMs;

    const { matchId } = await this.engine.createOpenMatch({
      gameCode: CRASH_GAME_CODE,
      stake: tier.stake,
      config: { ...config, tierId: tier.id, serverSeed, commitment, betsCloseAt },
    });

    await this.realtime.broadcast(crashRoundRoom(tier.id), CrashEvent.OPEN, {
      matchId,
      tierId: tier.id,
      commitment,
      betsCloseAt,
      limits: { betMin: config.betMin, betMax: config.betMax, currency: tier.currency },
    });

    const match = await this.matches.findMatch(matchId);
    if (match) this.armBettingClose(match, tier);
  }

  /** Arms (or re-arms) the window-close deadline from the round's recorded `betsCloseAt`. */
  private armBettingClose(match: MatchRow, tier: StakeTier): void {
    const timerId = `crash-window:${match.id}`;
    if (this.timers.remaining(timerId) !== null) return;

    const betsCloseAt = Number(match.config.betsCloseAt ?? 0);
    const delayMs = Math.max(0, betsCloseAt - Date.now());
    this.timers.schedule(timerId, delayMs, () => this.closeBetting(match.id, tier));
  }

  /**
   * Closes betting and lifts off — or voids a round nobody bet in.
   *
   * An empty window is an ordinary outcome, not a failure: there is no escrow to return
   * and nothing happened, so the round is voided and the next one opens immediately.
   */
  private async closeBetting(matchId: string, tier: StakeTier): Promise<void> {
    try {
      const { started, players } = await this.engine.startMatch(matchId);

      if (!started) {
        await this.engine.voidMatch(matchId, 'no bets placed');
        await this.ensureRound(tier);
        return;
      }

      const view = await this.engine.publicViewFor(matchId);
      await this.realtime.broadcast(crashRoundRoom(tier.id), CrashEvent.FLYING, {
        matchId,
        tierId: tier.id,
        players,
        ...(view ?? {}),
      });
    } catch (error) {
      this.logger.error(
        `crash round ${matchId} failed to start: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      // The round cannot fly, so it must not keep anyone's stake. Voiding refunds every
      // bet; the sweep opens a fresh round.
      await this.engine.voidMatch(matchId, 'round failed to start').catch(() => undefined);
    }
  }

  /**
   * Reacts to the engine finishing a round.
   *
   * The engine is the only thing that knows when a round actually crashed — the crash is
   * one of its timers, not one of ours — so the shared room is told from here rather than
   * guessed from a parallel clock that would inevitably disagree.
   */
  private async onMatchChanged(change: MatchChange): Promise<void> {
    if (change.gameCode !== CRASH_GAME_CODE) return;
    if (change.status !== 'settled' && change.status !== 'voided') return;

    const match = await this.matches.findMatch(change.matchId);
    if (!match) return;
    const tierId = String(match.config.tierId ?? '');
    if (!tierId) return;

    if (change.status === 'settled') {
      const view = await this.engine.publicViewFor(change.matchId);
      const crashedAtX100 = Number(view?.crashedAtX100 ?? 0);

      this.remember(tierId, change.matchId, crashedAtX100);
      await this.realtime.broadcast(crashRoundRoom(tierId), CrashEvent.CRASHED, {
        matchId: change.matchId,
        tierId,
        ...(view ?? {}),
      });
    }

    const tier = await this.tiers.findTier(tierId);
    if (!tier) return;
    const { config } = parseCrashConfig(tier.config);

    // The pause between rounds. Scheduled rather than slept so a shutdown does not sit on
    // a pending timer, and backed by the watchdog if this instance disappears first.
    this.timers.schedule(`crash-next:${tierId}`, config.interRoundMs, () => this.ensureRound(tier));
  }

  // --- player actions ------------------------------------------------------

  /**
   * Places a bet into the open round.
   *
   * The order of checks matters: everything cheap and refusable happens before any money
   * moves, and the two limits that depend on who else has bet are re-checked **inside the
   * join transaction** (the `guard`), because reading them beforehand is a race two
   * simultaneous bets would win together.
   */
  async placeBet(input: {
    userId: string;
    tierId: string;
    amount: number;
    autoCashOutX100?: number;
  }): Promise<{ matchId: string; amount: number; autoCashOutX100: number | null; balance: number }> {
    // Entering a round is entering play. The stake itself is checked again by the wallet
    // (ADR-026) — this is the earlier, cheaper refusal that keeps a excluded player from
    // getting as far as a failed bet.
    await this.rg.requirePlayEntry(input.userId);

    const tier = await this.requireTier(input.tierId);
    const { config } = parseCrashConfig(tier.config);

    if (!Number.isSafeInteger(input.amount) || input.amount < config.betMin || input.amount > config.betMax) {
      throw new BetOutOfBoundsError(config.betMin, config.betMax);
    }

    const autoCashOutX100 = input.autoCashOutX100 ?? null;
    if (autoCashOutX100 !== null) {
      if (
        !Number.isSafeInteger(autoCashOutX100) ||
        autoCashOutX100 <= BASE_X100 ||
        autoCashOutX100 > config.maxMultiplierX100
      ) {
        throw new InvalidAutoCashOutError(config.maxMultiplierX100);
      }
    }

    const round = await this.matches.findActiveRound(CRASH_GAME_CODE, tier.id);
    if (!round || round.status !== 'created') throw new NoOpenRoundError();

    await this.engine.joinMatch({
      matchId: round.id,
      userId: input.userId,
      stake: input.amount,
      meta: autoCashOutX100 === null ? {} : { autoCashOutX100 },
      guard: (players) => {
        const staked = players.reduce((sum, player) => sum + player.stake, 0) + input.amount;
        if (staked > config.maxRoundStake) {
          throw new RoundLimitReachedError('the round has taken its maximum stake');
        }

        // Worst case is every rider cashing out at the cap. The house's exposure is what
        // it would owe beyond the stakes it is already holding.
        // Rounded up, like a payout is: a worst case must never be understated.
        const worstCase = Math.ceil((staked * (crash.meta.maxPayoutX100 ?? 100)) / 100);
        if (worstCase - staked > config.maxHouseExposure) {
          throw new RoundLimitReachedError('it would exceed the table limit');
        }
      },
    });

    await this.realtime.broadcast(crashRoundRoom(tier.id), CrashEvent.BET, {
      matchId: round.id,
      tierId: tier.id,
      userId: input.userId,
      amount: input.amount,
    });

    const balance = await this.wallet.getBalance(input.userId, tier.currency);
    return { matchId: round.id, amount: input.amount, autoCashOutX100, balance: balance.amount };
  }

  /**
   * Cashes out.
   *
   * Nothing is decided here: the request is handed to the engine, the reducer prices it
   * against the recorded clock, and the answer comes back from the resulting state. The
   * client's idea of the current multiplier plays no part in it.
   */
  async cashOut(userId: string, matchId: string): Promise<{ cashedOutAtX100: number; payout: number }> {
    await this.engine.submitAction(matchId, { type: 'cashout', userId });

    const view = (await this.engine.viewFor(matchId, userId)).view as Record<string, unknown>;
    const yourBet = view.yourBet as { cashedOutAtX100: number | null } | null;
    const cashedOutAtX100 = yourBet?.cashedOutAtX100 ?? BASE_X100;

    const players = await this.matches.listPlayers(matchId);
    const stake = players.find((player) => player.userId === userId)?.stake ?? 0;

    return { cashedOutAtX100, payout: Math.floor((stake * cashedOutAtX100) / 100) };
  }

  /** The round a client renders: whatever exists right now for this tier. */
  async roundFor(tierId: string): Promise<CrashRoundPublic> {
    const tier = await this.requireTier(tierId);
    const { config } = parseCrashConfig(tier.config);
    const limits = { betMin: config.betMin, betMax: config.betMax, currency: tier.currency };

    const round = await this.matches.findActiveRound(CRASH_GAME_CODE, tierId);
    if (!round) {
      // Between rounds. Reported honestly rather than as an error: the client shows a
      // countdown to the next window instead of a failure.
      return {
        matchId: '',
        tierId,
        phase: 'betting',
        commitment: '',
        betsCloseAt: null,
        startedAt: null,
        tickMs: TICK_MS,
        growthPerMille: GROWTH_PER_MILLE,
        multiplierX100: BASE_X100,
        crashedAtX100: null,
        serverSeed: null,
        bets: [],
        limits,
      };
    }

    if (round.status === 'created') {
      // No game state exists yet — the betting window is the match's status, not something
      // the reducer models.
      const players = await this.matches.listPlayers(round.id);
      return {
        matchId: round.id,
        tierId,
        phase: 'betting',
        commitment: String(round.config.commitment ?? ''),
        betsCloseAt: Number(round.config.betsCloseAt ?? 0),
        startedAt: null,
        tickMs: TICK_MS,
        growthPerMille: GROWTH_PER_MILLE,
        multiplierX100: BASE_X100,
        crashedAtX100: null,
        serverSeed: null,
        bets: players.map((player) => ({
          userId: player.userId,
          amount: player.stake,
          cashedOutAtX100: null,
          payout: null,
        })),
        limits,
      };
    }

    const view = (await this.engine.publicViewFor(round.id)) ?? {};
    return {
      matchId: round.id,
      tierId,
      phase: (view.phase as CrashRoundPublic['phase']) ?? 'flying',
      commitment: String(view.commitment ?? round.config.commitment ?? ''),
      betsCloseAt: Number(round.config.betsCloseAt ?? 0),
      startedAt: (view.startedAt as number | undefined) ?? null,
      tickMs: TICK_MS,
      growthPerMille: GROWTH_PER_MILLE,
      multiplierX100: (view.multiplierX100 as number | undefined) ?? BASE_X100,
      crashedAtX100: (view.crashedAtX100 as number | null | undefined) ?? null,
      serverSeed: (view.serverSeed as string | null | undefined) ?? null,
      bets: (view.bets as CrashRoundPublic['bets'] | undefined) ?? [],
      limits,
    };
  }

  /** Recent crash points for a tier — the history strip, and nothing a dispute rests on. */
  recentOutcomes(tierId: string): Array<{ matchId: string; crashedAtX100: number }> {
    return [...(this.history.get(tierId) ?? [])];
  }

  /** Config as a round would use it — exposed for tests and the rules endpoint. */
  configFor(tier: StakeTier): CrashConfig {
    return parseCrashConfig(tier.config).config;
  }

  private remember(tierId: string, matchId: string, crashedAtX100: number): void {
    const entries = this.history.get(tierId) ?? [];
    entries.unshift({ matchId, crashedAtX100 });
    this.history.set(tierId, entries.slice(0, HISTORY_LENGTH));
  }

  private async requireTier(tierId: string): Promise<StakeTier> {
    const tier = await this.tiers.findTier(tierId);
    if (!tier || !tier.enabled || tier.gameCode !== CRASH_GAME_CODE) {
      throw new CrashTierUnavailableError();
    }
    // Fail-closed per-game kill-switch (rule 16): a disabled game takes no new bets, even
    // into a round that is already open.
    if (!(await this.flags.isEnabled(gameEnabledKey(CRASH_GAME_CODE)))) {
      throw new CrashTierUnavailableError();
    }
    return tier;
  }
}
