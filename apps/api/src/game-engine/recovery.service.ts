import { Injectable, Logger } from '@nestjs/common';
import { EngineService } from './engine.service';
import { MatchRepository } from './match.repository';

export interface RecoveryOutcome {
  matchId: string;
  action: 'resumed' | 'voided' | 'settled';
  reason?: string;
}

/**
 * Crash recovery (`docs/01-architecture/game-architecture.md`).
 *
 * A match left mid-play by a crash is in one of two situations:
 *  - its event log replays cleanly, so play resumes from the rebuilt state; or
 *  - it does not, so the match is **voided and every buy-in refunded**.
 *
 * There is deliberately no third option. Guessing an outcome for a match whose history
 * cannot be trusted would invent a result, and quietly keeping the stakes would take money
 * for a game that never concluded. Refunding is the only defensible answer, and it is
 * audited.
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly engine: EngineService,
    private readonly matches: MatchRepository,
  ) {}

  /** Page size and overall bound for one sweep. */
  static readonly batchSize = 100;
  static readonly maxPerSweep = 2_000;

  /**
   * Sweeps every match left in a non-terminal state. Run at startup and on demand.
   *
   * Walks the whole set with a cursor rather than repeatedly reading the first page:
   * a resumed match stays `in_progress`, so a LIMIT-only query would revisit the same
   * matches and never reach the ones behind them. Bounded by `maxPerSweep` so a corrupt
   * backlog cannot hold startup hostage — anything left is reported, not silently dropped.
   */
  async recoverAll(): Promise<RecoveryOutcome[]> {
    const total = await this.matches.countRecoverableMatches();
    if (total === 0) return [];

    this.logger.log(`recovering ${total} in-flight match(es)`);

    const outcomes: RecoveryOutcome[] = [];
    let cursor: string | undefined;

    while (outcomes.length < RecoveryService.maxPerSweep) {
      const batch = await this.matches.findRecoverableMatches(RecoveryService.batchSize, cursor);
      if (batch.length === 0) break;

      for (const matchId of batch) {
        outcomes.push(await this.recover(matchId));
      }
      cursor = batch.at(-1);
    }

    this.logSummary(outcomes, total);
    return outcomes;
  }

  /**
   * Logs counts, not identifiers.
   *
   * An earlier version listed every match id on one line — unreadable at 100 matches and
   * useless at 10,000. Only voided matches are named, because those are the ones a human
   * has to look at: money moved and players lost a game.
   */
  private logSummary(outcomes: RecoveryOutcome[], total: number): void {
    const counts = outcomes.reduce<Record<string, number>>((acc, outcome) => {
      acc[outcome.action] = (acc[outcome.action] ?? 0) + 1;
      return acc;
    }, {});

    const summary = Object.entries(counts)
      .map(([action, count]) => `${action}=${count}`)
      .join(', ');
    this.logger.log(`startup recovery complete: ${summary} (of ${total} in flight)`);

    const voided = outcomes.filter((outcome) => outcome.action === 'voided');
    if (voided.length > 0) {
      // Voided matches refunded players and ended a game they were playing — worth naming,
      // capped so a mass failure does not bury the rest of the log.
      const named = voided.slice(0, 20).map((outcome) => `${outcome.matchId} (${outcome.reason})`);
      this.logger.warn(
        `voided ${voided.length} unrecoverable match(es): ${named.join('; ')}` +
          (voided.length > named.length ? ` … and ${voided.length - named.length} more` : ''),
      );
    }

    if (outcomes.length >= RecoveryService.maxPerSweep) {
      this.logger.error(
        `recovery stopped at the ${RecoveryService.maxPerSweep}-match cap; ` +
          'in-flight matches remain unverified — investigate before serving traffic',
      );
    }
  }

  async recover(matchId: string): Promise<RecoveryOutcome> {
    const match = await this.matches.findMatch(matchId);
    if (!match) return { matchId, action: 'voided', reason: 'match not found' };

    const verification = await this.engine.replayAndVerify(matchId);

    if (!verification.ok) {
      const reason = `unrecoverable: ${verification.reason ?? 'replay failed'}`;
      await this.engine.voidMatch(matchId, reason);
      return { matchId, action: 'voided', reason };
    }

    // A match that crashed after reaching a terminal state — between deciding the outcome
    // and paying it — is finished, not resumed. Settlement is idempotent, so completing it
    // is safe even if the original attempt partly succeeded.
    if (match.status === 'settling') {
      await this.engine.settle(matchId);
      return { matchId, action: 'settled' };
    }

    // Re-arm whatever deadline the rebuilt state calls for.
    //
    // Timers live in the process that armed them, so a restart loses every one. A game
    // driven by player actions survives that — the next action re-arms it. A game whose
    // clock runs on its own does not: a resumed Crash round would sit in flight forever,
    // stakes in escrow, waiting for a crash that can no longer happen.
    await this.engine.armPendingTimer(matchId);
    return { matchId, action: 'resumed' };
  }
}
