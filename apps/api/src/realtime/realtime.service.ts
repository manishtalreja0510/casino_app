import { Injectable, Logger } from '@nestjs/common';
import type { Namespace } from 'socket.io';
import { SequencerService } from './sequencer.service';
import { ServerEvent, type RealtimeEnvelope } from './realtime.types';

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
    return this.broadcast(`user:${userId}`, type, payload);
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
