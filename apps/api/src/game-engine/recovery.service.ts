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

  /** Sweeps every match left in a non-terminal state. Run at startup and on demand. */
  async recoverAll(): Promise<RecoveryOutcome[]> {
    const matchIds = await this.matches.findRecoverableMatches();
    if (matchIds.length === 0) return [];

    this.logger.log(`recovering ${matchIds.length} in-flight match(es)`);
    const outcomes: RecoveryOutcome[] = [];
    for (const matchId of matchIds) {
      outcomes.push(await this.recover(matchId));
    }
    return outcomes;
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

    return { matchId, action: 'resumed' };
  }
}
