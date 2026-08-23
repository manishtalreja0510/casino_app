import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { ErrorCode } from '@casino/contracts';
import { PG_POOL } from '../platform/database/database.module';
import { DomainError } from '../platform/errors/domain-error';
import { FlagsService } from '../platform/flags/flags.service';
import { gameEnabledKey } from '../platform/flags/flag-keys';
import { EngineService } from '../game-engine/engine.service';
import { GameRegistry } from '../game-engine/game.registry';
import { WalletService } from '../wallet/wallet.service';
import { RealtimeService } from '../realtime/realtime.service';
import { QueueService } from './queue.service';
import { MatchmakingRepository, type StakeTier } from './matchmaking.repository';

export class AlreadyInMatchError extends DomainError {
  constructor() {
    super(ErrorCode.GAME_INVALID_ACTION, 'You are already in a match', 409);
  }
}

export class TierUnavailableError extends DomainError {
  constructor() {
    super(ErrorCode.GAME_DISABLED, 'That stake tier is not available', 404);
  }
}

export class InsufficientBalanceForTierError extends DomainError {
  constructor() {
    super(ErrorCode.WALLET_INSUFFICIENT_FUNDS, 'Not enough funds for this stake', 409);
  }
}

/**
 * Matchmaking (`docs/02-domains/matchmaking.md`).
 *
 * The whole phase turns on one guarantee: a formation seats **everyone and charges
 * everyone**, or **nobody**. Everything else — queues, tiers, lobby counts — is
 * convenience around that.
 */
@Injectable()
export class MatchmakingService {
  private readonly logger = new Logger(MatchmakingService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly queues: QueueService,
    private readonly repository: MatchmakingRepository,
    private readonly engine: EngineService,
    private readonly registry: GameRegistry,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeService,
    private readonly flags: FlagsService,
  ) {}

  async joinQueue(userId: string, tierId: string): Promise<{ queued: boolean; matchId?: string }> {
    const tier = await this.requirePlayableTier(tierId);

    // Refused before queueing, not discovered during formation — a player who cannot
    // afford the tier must never be the reason someone else's match falls apart.
    if (tier.stake > 0) {
      const balance = await this.wallet.getBalance(userId, tier.currency);
      if (balance.amount < tier.stake) throw new InsufficientBalanceForTierError();
    }

    const active = await this.repository.activeMatchesFor(userId);
    if (active.length > 0) throw new AlreadyInMatchError();

    await this.queues.join({ userId, tierId, gameCode: tier.gameCode, joinedAt: Date.now() });

    // Try immediately: the player who completes a pairing should not wait for a sweep.
    const formed = await this.tryForm(tier);
    await this.publishLobby(tier.gameCode);

    if (formed?.userIds.includes(userId)) return { queued: false, matchId: formed.matchId };
    return { queued: true };
  }

  async leaveQueue(userId: string, tierId: string): Promise<{ left: boolean }> {
    const left = await this.queues.leave(tierId, userId);
    const tier = await this.repository.findTier(tierId);
    if (tier) await this.publishLobby(tier.gameCode);
    return { left };
  }

  async queueStatus(userId: string, tierId: string): Promise<{ queued: boolean; depth: number }> {
    const [queued, depth] = await Promise.all([
      this.queues.isQueued(tierId, userId),
      this.queues.depth(tierId),
    ]);
    if (queued) await this.queues.touch(tierId, userId);
    return { queued, depth };
  }

  /**
   * Attempts one formation for a tier.
   *
   * Players are claimed atomically from Redis, then everything that could still refuse
   * them is re-checked inside the match transaction — a claim proves only that nobody
   * else took them, not that they are still eligible.
   */
  async tryForm(tier: StakeTier): Promise<{ matchId: string; userIds: string[] } | null> {
    const definition = this.registry.latest(tier.gameCode);
    const needed = definition.meta.minPlayers;

    const claimed = await this.queues.claim(tier.id, needed);
    if (claimed.length < needed) return null;

    // Distinct players only. A player queued from two devices should be impossible
    // (join refuses a duplicate), but seating someone against themselves would be such a
    // visible failure that it is checked again here.
    const unique = [...new Set(claimed)];
    if (unique.length < needed) {
      await this.queues.requeue(tier.id, unique);
      return null;
    }

    for (const userId of unique) {
      const active = await this.repository.activeMatchesFor(userId);
      if (active.length > 0) {
        // Someone became busy between queueing and being claimed: return the others to
        // the queue rather than forming a short match.
        const others = unique.filter((id) => id !== userId);
        await this.queues.requeue(tier.id, others);
        await this.repository.recordFormation({
          matchId: null,
          gameCode: tier.gameCode,
          tierId: tier.id,
          userIds: unique,
          outcome: 'failed',
          reason: 'player_already_in_match',
        });
        return null;
      }
    }

    try {
      // createMatch commits the match and every buy-in in ONE transaction: if any player
      // cannot pay, nobody is charged and nobody is seated.
      const { matchId } = await this.engine.createMatch({
        gameCode: tier.gameCode,
        players: unique.map((userId) => ({ userId })),
        stake: tier.stake,
      });

      await this.repository.recordFormation({
        matchId,
        gameCode: tier.gameCode,
        tierId: tier.id,
        userIds: unique,
        outcome: 'formed',
      });

      for (const userId of unique) {
        await this.realtime.toUser(userId, 'match:found', {
          matchId,
          gameCode: tier.gameCode,
          tierId: tier.id,
          stake: tier.stake,
        });
      }

      this.logger.log(`formed ${tier.gameCode} match ${matchId} from tier ${tier.id}`);
      return { matchId, userIds: unique };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`formation failed for tier ${tier.id}: ${reason}`);

      await this.repository.recordFormation({
        matchId: null,
        gameCode: tier.gameCode,
        tierId: tier.id,
        userIds: unique,
        outcome: 'failed',
        reason,
      });

      // The transaction rolled back, so nobody was charged. Players whose own funds were
      // the problem are left out; the rest go back to the queue.
      await this.queues.requeue(tier.id, unique);
      return null;
    }
  }

  /** Sweeps every tier — a safety net for players left waiting by a failed attempt. */
  async sweep(): Promise<number> {
    const tiers = await this.repository.listTiers();
    let formed = 0;
    for (const tier of tiers) {
      const enabled = await this.flags.isEnabled(gameEnabledKey(tier.gameCode));
      if (!enabled) continue;
      if ((await this.tryForm(tier)) !== null) formed++;
    }
    return formed;
  }

  async lobby(): Promise<{
    games: Array<{
      gameCode: string;
      name: string;
      enabled: boolean;
      activeMatches: number;
      tiers: Array<{ id: string; name: string; stake: number; currency: string; queueDepth: number }>;
    }>;
  }> {
    const tiers = await this.repository.listTiers();
    const byGame = new Map<string, StakeTier[]>();
    for (const tier of tiers) {
      byGame.set(tier.gameCode, [...(byGame.get(tier.gameCode) ?? []), tier]);
    }

    const games = [];
    for (const [gameCode, gameTiers] of byGame) {
      const [enabled, activeMatches] = await Promise.all([
        this.flags.isEnabled(gameEnabledKey(gameCode)),
        this.repository.countActiveMatches(gameCode),
      ]);

      const withDepth = [];
      for (const tier of gameTiers) {
        withDepth.push({
          id: tier.id,
          name: tier.name,
          stake: tier.stake,
          currency: tier.currency,
          queueDepth: await this.queues.depth(tier.id),
        });
      }

      let name = gameCode;
      try {
        name = this.registry.latest(gameCode).meta.name;
      } catch {
        // A tier configured for a game that is not installed: listed as disabled rather
        // than crashing the lobby for everyone.
      }

      games.push({ gameCode, name, enabled, activeMatches, tiers: withDepth });
    }

    return { games };
  }

  private async publishLobby(gameCode: string): Promise<void> {
    const snapshot = await this.lobby();
    const game = snapshot.games.find((entry) => entry.gameCode === gameCode);
    if (game) await this.realtime.broadcast(`lobby:${gameCode}`, 'lobby:update', game);
  }

  private async requirePlayableTier(tierId: string): Promise<StakeTier> {
    const tier = await this.repository.findTier(tierId);
    if (!tier || !tier.enabled) throw new TierUnavailableError();

    // Per-game kill-switch (rule 16): a disabled game accepts no new queueing.
    if (!(await this.flags.isEnabled(gameEnabledKey(tier.gameCode)))) throw new TierUnavailableError();
    return tier;
  }
}
