import { Injectable, Logger } from '@nestjs/common';
import type { Namespace } from 'socket.io';
import type { GameEventOut } from '@casino/contracts';
import { SequencerService } from './sequencer.service';
import { Rooms, ServerEvent, type RealtimeEnvelope } from './realtime.types';

/**
 * Broadcast surface used by the rest of the platform (the engine, from P6).
 *
 * Callers name a room and an event; sequencing, buffering and delivery are handled here.
 * Nothing outside this service touches the Socket.IO server directly, so the guarantees
 * — ordering, replayability — hold for every emitter.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private namespace?: Namespace;

  constructor(private readonly sequencer: SequencerService) {}

  /** Called once by the gateway when Socket.IO is ready. */
  bind(namespace: Namespace): void {
    this.namespace = namespace;
  }

  /**
   * Broadcasts to a room. Every recipient in the room sees the same envelope; per-player
   * filtering of hidden information is the engine's job, done by emitting to per-user
   * rooms instead (P6, `playerView`).
   */
  async broadcast<T>(room: string, type: string, payload: T): Promise<RealtimeEnvelope<T>> {
    const envelope = await this.sequencer.record(room, type, payload);
    this.namespace?.to(room).emit(ServerEvent.EVENT, envelope);
    return envelope;
  }

  /** Sequenced delivery to one user across all their connections. */
  async toUser<T>(userId: string, type: string, payload: T): Promise<RealtimeEnvelope<T>> {
    return this.broadcast(Rooms.user(userId), type, payload);
  }

  /**
   * Delivers a reducer's events — **the only path game events take to a client**.
   *
   * The reason this is one method rather than a call at each site is the replay buffer.
   * Sequencing and buffering are per *room*: everything sent to `match:{id}` sits in one
   * buffer that every participant can replay on reconnect. Emitting a private event to
   * the match room — even addressed to specific sockets — therefore leaks it to everyone
   * who resumes afterwards. It would look correct in every live test and fail only on the
   * reconnect path, which is the path nobody exercises by hand.
   *
   * So privacy is expressed as **routing**, not as filtering: a private event goes to its
   * owner's room, which has exactly one member and its own buffer. There is no filter to
   * forget, and no way to address a shared room with a private payload.
   *
   * Poker's hole cards are the case this exists for (P9).
   */
  async deliver(
    matchId: string,
    events: readonly GameEventOut[],
    context: { matchSeq: number; participants: readonly string[] },
  ): Promise<void> {
    for (const event of events) {
      // Every event carries the match's own sequence so a client can order the two
      // streams it now receives — the shared room and its own — against each other.
      // Room `seq` detects gaps in transport; `matchSeq` is the order of play.
      const payload = { ...(event.payload ?? {}), matchSeq: context.matchSeq };

      // `undefined` means public. An *empty* `onlyTo` means "private, and it turned out
      // nobody should see this" — delivered to nobody. Treating the two the same would
      // broadcast hidden information the moment a game computed an empty recipient list,
      // which is exactly when it is least expecting to.
      if (event.onlyTo === undefined) {
        await this.broadcast(Rooms.match(matchId), event.type, payload);
        continue;
      }

      for (const userId of event.onlyTo) {
        // A game addressing a non-participant would hand hidden information to someone
        // who is not even in the match. Refused rather than trusted.
        if (!context.participants.includes(userId)) {
          this.logger.error(
            `match ${matchId}: refused a private "${event.type}" addressed to ${userId}, ` +
              'who is not in the match',
          );
          continue;
        }
        await this.toUser(userId, event.type, payload);
      }
    }
  }

  async roomSize(room: string): Promise<number> {
    if (!this.namespace) return 0;
    const sockets = await this.namespace.in(room).fetchSockets();
    return sockets.length;
  }

  /** Disconnects every socket of a user — used when a session is revoked. */
  async disconnectUser(userId: string, reason: string): Promise<void> {
    if (!this.namespace) return;
    const sockets = await this.namespace.in(`user:${userId}`).fetchSockets();
    for (const socket of sockets) {
      socket.emit(ServerEvent.ERROR, { code: 'AUTH_TOKEN_INVALID', message: reason });
      socket.disconnect(true);
    }
  }
}
