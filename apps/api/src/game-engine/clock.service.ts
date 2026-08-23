import { Injectable } from '@nestjs/common';

/**
 * The reducer's clock (ADR-009, ADR-023).
 *
 * `GameContext.now()` was always documented as "deterministic during replay", but until
 * P8 the engine handed reducers `Date.now()` directly. Nothing noticed, because the
 * reference game never asks the time — and a game that never asks the time replays
 * identically whatever the clock does.
 *
 * Crash asks constantly: its entire outcome is a function of elapsed milliseconds. With a
 * live clock, replaying a finished round would price every cash-out at whatever time the
 * replay happened to run — which is to say recovery would produce a different match than
 * the one that was played, and a dispute would be unanswerable.
 *
 * So the clock is recorded exactly like an RNG draw: reads are captured with the event
 * that consumed them and fed back in order during replay.
 */
@Injectable()
export class ClockService {
  /** A recording clock for one action. Reads accumulate for persistence with the event. */
  createRecorder(): { now(): number; reads: number[] } {
    const reads: number[] = [];
    return {
      now(): number {
        const value = Date.now();
        reads.push(value);
        return value;
      },
      reads,
    };
  }

  /**
   * A replaying clock returning previously recorded reads in order.
   *
   * Running past the recorded reads means the game consults the clock in a different
   * pattern than it did when the events were written — the logic has changed under a
   * match in flight. That is a hard error, never a silent fresh reading: a silent one
   * would make replay *look* successful while producing a different match.
   */
  createReplayer(recorded: readonly number[]): { now(): number } {
    let index = 0;
    return {
      now(): number {
        const value = recorded[index++];
        if (value === undefined) {
          throw new Error(
            'replay consumed more clock reads than were recorded — ' +
              'game logic has diverged from the event log',
          );
        }
        return value;
      },
    };
  }
}
