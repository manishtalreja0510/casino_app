import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../platform/redis/redis.module';
import { REALTIME_PROTOCOL_VERSION, type RealtimeEnvelope } from './realtime.types';

/**
 * Per-room sequencing and the replay buffer (`docs/01-architecture/realtime-architecture.md`).
 *
 * Every room has a monotonic counter; each broadcast is stamped with the next value and
 * kept in a bounded ring buffer. A reconnecting client says what it last applied and
 * receives exactly the gap — or is told to resync when the gap is bigger than the buffer.
 *
 * Redis holds this because it is ephemeral by design (rule 7): losing it costs clients a
 * full resync, never money or match state. The authoritative record of a match is the
 * engine's PostgreSQL event log (P6).
 */
@Injectable()
export class SequencerService {
  private readonly logger = new Logger(SequencerService.name);

  /** Roughly two minutes of busy play; enough for a tunnel or a lift, not for a nap. */
  static readonly bufferSize = 512;
  static readonly bufferTtlSeconds = 15 * 60;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Stamps an event with the room's next sequence and buffers it for replay. */
  async record<T>(room: string, type: string, payload: T): Promise<RealtimeEnvelope<T>> {
    const seq = await this.redis.incr(SequencerService.seqKey(room));
    const envelope: RealtimeEnvelope<T> = {
      v: REALTIME_PROTOCOL_VERSION,
      seq,
      type,
      ts: Date.now(),
      room,
      payload,
    };

    // Buffer write is best-effort: a failure costs a resync on reconnect, which is
    // recoverable, so it must not fail the broadcast itself.
    try {
      const key = SequencerService.bufferKey(room);
      await this.redis
        .multi()
        .rpush(key, JSON.stringify(envelope))
        .ltrim(key, -SequencerService.bufferSize, -1)
        .expire(key, SequencerService.bufferTtlSeconds)
        .expire(SequencerService.seqKey(room), SequencerService.bufferTtlSeconds)
        .exec();
    } catch (error) {
      this.logger.warn(
        `replay buffer write failed for ${room}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    return envelope;
  }

  async currentSeq(room: string): Promise<number> {
    const value = await this.redis.get(SequencerService.seqKey(room));
    return value ? Number(value) : 0;
  }

  /**
   * Events after `lastSeq`.
   *
   * `resyncRequired` is returned when the gap cannot be served from the buffer — either
   * the client is too far behind, or (the subtler case) it reports a sequence ahead of
   * the server's, which happens after a Redis flush. Replaying a partial gap would leave
   * the client silently inconsistent, so a full resync is the only safe answer.
   */
  async replay(
    room: string,
    lastSeq: number,
  ): Promise<{ events: RealtimeEnvelope[]; resyncRequired: boolean }> {
    const current = await this.currentSeq(room);

    if (lastSeq > current) return { events: [], resyncRequired: true };
    if (lastSeq === current) return { events: [], resyncRequired: false };

    const buffered = await this.redis.lrange(SequencerService.bufferKey(room), 0, -1);
    const events = buffered
      .map((raw) => JSON.parse(raw) as RealtimeEnvelope)
      .filter((event) => event.seq > lastSeq)
      .sort((a, b) => a.seq - b.seq);

    // The gap is only fully covered if the first event we hold is the very next one.
    const covered = events.length > 0 && events[0]!.seq === lastSeq + 1;
    if (!covered) return { events: [], resyncRequired: true };

    return { events, resyncRequired: false };
  }

  /** Drops a room's sequence and buffer — used when a match ends. */
  async clear(room: string): Promise<void> {
    await this.redis.del(SequencerService.seqKey(room), SequencerService.bufferKey(room));
  }

  private static seqKey(room: string): string {
    return `rt:seq:${room}`;
  }

  private static bufferKey(room: string): string {
    return `rt:buf:${room}`;
  }
}
