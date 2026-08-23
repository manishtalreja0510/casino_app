import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export interface RngDraw {
  /** What the draw was for, e.g. `coin-flip` or `shuffle:deck`. */
  purpose: string;
  max: number;
  value: number;
}

/**
 * Server-side randomness (ADR-016).
 *
 * Two properties matter:
 *  - **Only the server draws.** A client-supplied or client-influenced value is not
 *    randomness, it is an input an attacker controls (rule 1).
 *  - **Every draw is recorded** with its purpose and persisted alongside the event that
 *    consumed it, so a disputed outcome can be re-examined and a replay reproduces the
 *    original result exactly.
 *
 * `randomInt` is used rather than `Math.random()` or a modulo of random bytes: it is
 * cryptographically sourced and rejection-samples, so the distribution is uniform.
 * Licensing will require a certified RNG (GLI-19-class); that module slots in behind this
 * interface without any game changing.
 */
@Injectable()
export class RngService {
  /** A recording drawer for one match. Draws accumulate for persistence with the event. */
  createRecorder(): { random(max: number, purpose: string): number; draws: RngDraw[] } {
    const draws: RngDraw[] = [];
    return {
      random(max: number, purpose: string): number {
        if (!Number.isInteger(max) || max <= 0) {
          throw new Error(`random(max) needs a positive integer, got ${max}`);
        }
        const value = randomInt(0, max);
        draws.push({ purpose, max, value });
        return value;
      },
      draws,
    };
  }

  /**
   * A replaying drawer that returns previously recorded values in order.
   *
   * This is what makes recovery sound: replaying a match must reproduce the same
   * outcomes, so the reducer is fed the draws it originally consumed rather than fresh
   * ones. Running past the recorded draws means the game logic has changed since the
   * events were written — a hard error, never a silent fresh draw.
   */
  createReplayer(recorded: readonly RngDraw[]): { random(max: number, purpose: string): number } {
    let index = 0;
    return {
      random(max: number, purpose: string): number {
        const draw = recorded[index++];
        if (!draw) {
          throw new Error(
            `replay consumed more RNG draws than were recorded (purpose "${purpose}") — ` +
              'game logic has diverged from the event log',
          );
        }
        if (draw.max !== max || draw.purpose !== purpose) {
          throw new Error(
            `replay draw mismatch: recorded ${draw.purpose}/${draw.max}, requested ${purpose}/${max}`,
          );
        }
        return draw.value;
      },
    };
  }

  /**
   * Commit–reveal for provably-fair games (the Crash candidate in OQ-05).
   *
   * The server publishes `commitment` before betting opens and reveals `serverSeed`
   * afterwards; anyone can verify the hash and recompute the outcome. It proves the server
   * did not pick the result after seeing the bets — it does not make the game "fair" in
   * any broader sense, and the docs should not claim it does.
   */
  createCommitment(): { serverSeed: string; commitment: string } {
    const serverSeed = randomBytes(32).toString('hex');
    return { serverSeed, commitment: createHash('sha256').update(serverSeed).digest('hex') };
  }

  static verifyCommitment(serverSeed: string, commitment: string): boolean {
    return createHash('sha256').update(serverSeed).digest('hex') === commitment;
  }
}
