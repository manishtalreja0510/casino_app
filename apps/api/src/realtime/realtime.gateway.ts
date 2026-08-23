import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';

import { ConfigService } from '@nestjs/config';
import { AuthRepository } from '../auth/auth.repository';
import { TicketService } from './ticket.service';
import { SequencerService } from './sequencer.service';
import { PresenceService } from './presence.service';
import { RealtimeService } from './realtime.service';
import {
  ClientEvent,
  Rooms,
  ServerEvent,
  type JoinRequest,
  type ResumeRequest,
  type SocketIdentity,
} from './realtime.types';

interface IdentifiedSocket extends Socket {
  identity?: SocketIdentity;
  /** Rooms this socket was authorised into — the server's record, not the client's claim. */
  joinedRooms?: Set<string>;
}

/**
 * `/game` namespace (ADR-007).
 *
 * Two properties matter most here:
 *  - **Identity is established once, at handshake, from a single-use ticket** — never
 *    from anything the client asserts later.
 *  - **Every join is authorised server-side and re-checks the session.** A revoked
 *    session cannot keep playing merely because it already holds a socket.
 */
@WebSocketGateway({
  namespace: '/game',
  // WebSocket only: long-polling would need sticky sessions at the load balancer, and
  // the fallback is not worth that operational constraint for a game client we control.
  transports: ['websocket'],
  pingInterval: 20_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 32 * 1024,
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnApplicationShutdown
{
  private readonly logger = new Logger(RealtimeGateway.name);

  /**
   * For a namespaced gateway Nest injects the **Namespace**, not the Server. Emitting
   * through the namespace is what keeps events inside `/game`.
   */
  @WebSocketServer()
  namespace!: Namespace;

  private adapterClients: Redis[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly tickets: TicketService,
    private readonly sequencer: SequencerService,
    private readonly presence: PresenceService,
    private readonly realtime: RealtimeService,
    private readonly authRepository: AuthRepository,
  ) {}

  async afterInit(namespace: Namespace): Promise<void> {
    // The Redis adapter is what makes a room span instances: a broadcast on one instance
    // reaches sockets held by another, which is the whole basis of horizontal scaling.
    //
    // `adapter()` is a method on the io Server, not on a Namespace — a namespaced gateway
    // receives the latter, so reach through to `namespace.server`.
    //
    // Dedicated clients, NOT duplicates of the application client. The app client
    // deliberately runs with `enableOfflineQueue: false` so ordinary traffic fails fast
    // on a dead cache — but the adapter issues its SUBSCRIBE immediately, while the
    // connection is still opening, and that rejection silently leaves the adapter
    // unsubscribed: broadcasts then never cross instances, with nothing in the logs to
    // say so. The adapter's clients therefore queue, and we wait for both to be ready
    // before attaching.
    const url = this.config.getOrThrow<string>('REDIS_URL');
    const adapterOptions = { maxRetriesPerRequest: null, enableOfflineQueue: true } as const;
    const pubClient = new Redis(url, adapterOptions);
    const subClient = new Redis(url, adapterOptions);
    this.adapterClients = [pubClient, subClient];

    for (const client of this.adapterClients) {
      client.on('error', (error: Error) => this.logger.warn(`redis adapter: ${error.message}`));
      if (client.status !== 'ready') {
        await new Promise<void>((resolve) => client.once('ready', () => resolve()));
      }
    }

    namespace.server.adapter(createAdapter(pubClient, subClient));

    // Authentication runs as handshake middleware, not in `handleConnection`.
    //
    // A socket rejected in `handleConnection` has already completed the handshake — the
    // client sees a successful `connect` and is disconnected a moment later, so for an
    // instant an unauthenticated socket exists on the server. Rejecting in middleware
    // means the connection is never established and the client gets `connect_error`.
    namespace.use(async (socket, next) => {
      const identified = socket as IdentifiedSocket;
      const ticket = String(socket.handshake.auth?.ticket ?? socket.handshake.query?.ticket ?? '');

      const identity = await this.tickets.consume(ticket);
      if (!identity) {
        next(new Error('invalid_ticket'));
        return;
      }

      // The ticket proves who requested it; the session must still be live right now.
      const session = await this.authRepository.findSession(identity.sessionId);
      if (!session || session.revokedAt !== null) {
        next(new Error('session_ended'));
        return;
      }

      identified.identity = identity;
      identified.joinedRooms = new Set();
      next();
    });

    this.realtime.bind(namespace);
    this.logger.log('realtime gateway ready (redis adapter attached)');
  }

  async handleConnection(socket: IdentifiedSocket): Promise<void> {
    const identity = socket.identity;
    if (!identity) {
      // Unreachable while the middleware above is installed; treated as a hard failure
      // rather than an assumption.
      socket.disconnect(true);
      return;
    }

    // Every socket joins its own user room, so the server can reach a specific player
    // without the client asking for it.
    const userRoom = Rooms.user(identity.userId);
    socket.joinedRooms ??= new Set();
    await socket.join(userRoom);
    socket.joinedRooms.add(userRoom);
    await this.presence.join(userRoom, identity.userId, socket.id);
  }

  /** Closes the adapter's own connections with the app. */
  async onApplicationShutdown(): Promise<void> {
    for (const client of this.adapterClients) client.disconnect();
    this.adapterClients = [];
  }

  async handleDisconnect(socket: IdentifiedSocket): Promise<void> {
    for (const room of socket.joinedRooms ?? []) {
      await this.presence.leave(room, socket.id);
    }
  }

  @SubscribeMessage(ClientEvent.JOIN)
  async onJoin(
    @ConnectedSocket() socket: IdentifiedSocket,
    @MessageBody() body: JoinRequest,
  ): Promise<{ ok: boolean; room?: string; seq?: number; error?: string }> {
    const identity = socket.identity;
    if (!identity) return { ok: false, error: 'not_authenticated' };

    const room = String(body?.room ?? '');
    if (!RealtimeGateway.isWellFormedRoom(room)) return { ok: false, error: 'invalid_room' };

    // Authorisation, not politeness: the client may only join rooms it has a claim on.
    // Match membership is delegated to the engine in P6; until then only own-user rooms
    // and match rooms the player is present in are permitted.
    if (!(await this.canJoin(identity, room))) return { ok: false, error: 'forbidden' };

    // Re-check the session on every join: a revocation must stop play immediately, not
    // whenever the socket happens to drop.
    const session = await this.authRepository.findSession(identity.sessionId);
    if (!session || session.revokedAt !== null) {
      socket.emit(ServerEvent.ERROR, { code: 'AUTH_TOKEN_INVALID', message: 'Session ended' });
      socket.disconnect(true);
      return { ok: false, error: 'session_ended' };
    }

    await socket.join(room);
    socket.joinedRooms?.add(room);
    await this.presence.join(room, identity.userId, socket.id);

    const seq = await this.sequencer.currentSeq(room);
    socket.emit(ServerEvent.JOINED, { room, seq });
    return { ok: true, room, seq };
  }

  @SubscribeMessage(ClientEvent.LEAVE)
  async onLeave(
    @ConnectedSocket() socket: IdentifiedSocket,
    @MessageBody() body: JoinRequest,
  ): Promise<{ ok: boolean }> {
    const room = String(body?.room ?? '');
    await socket.leave(room);
    socket.joinedRooms?.delete(room);
    await this.presence.leave(room, socket.id);
    socket.emit(ServerEvent.LEFT, { room });
    return { ok: true };
  }

  /**
   * Resume after a reconnect.
   *
   * Works across instances because the sequence and buffer live in Redis, not in the
   * process that sent the original events — the client may well come back to a different
   * server than the one it left.
   */
  @SubscribeMessage(ClientEvent.RESUME)
  async onResume(
    @ConnectedSocket() socket: IdentifiedSocket,
    @MessageBody() body: ResumeRequest,
  ): Promise<{ ok: boolean; replayed?: number; resync?: boolean; error?: string }> {
    const identity = socket.identity;
    if (!identity) return { ok: false, error: 'not_authenticated' };

    const room = String(body?.room ?? '');
    const lastSeq = Number(body?.lastSeq ?? 0);
    if (!RealtimeGateway.isWellFormedRoom(room) || !Number.isFinite(lastSeq) || lastSeq < 0) {
      return { ok: false, error: 'invalid_request' };
    }
    if (!(await this.canJoin(identity, room))) return { ok: false, error: 'forbidden' };

    if (!socket.joinedRooms?.has(room)) {
      await socket.join(room);
      socket.joinedRooms?.add(room);
      await this.presence.join(room, identity.userId, socket.id);
    }

    const { events, resyncRequired } = await this.sequencer.replay(room, lastSeq);

    if (resyncRequired) {
      // Explicitly telling the client to resync is the point: silently sending a partial
      // gap would leave it inconsistent without either side knowing.
      socket.emit(ServerEvent.RESYNC_REQUIRED, { room, currentSeq: await this.sequencer.currentSeq(room) });
      return { ok: true, resync: true };
    }

    for (const event of events) socket.emit(ServerEvent.EVENT, event);
    socket.emit(ServerEvent.RESUME_COMPLETE, { room, replayed: events.length });
    return { ok: true, replayed: events.length };
  }

  /** Room-membership authorisation. Extended by the engine in P6 with match rosters. */
  private async canJoin(identity: SocketIdentity, room: string): Promise<boolean> {
    if (room === Rooms.user(identity.userId)) return true;
    if (room.startsWith('user:')) return false; // never another player's room
    if (room.startsWith('match:')) return true; // engine narrows this to actual participants (P6)
    return false;
  }

  private static isWellFormedRoom(room: string): boolean {
    return /^(user|match):[A-Za-z0-9-]{1,64}$/.test(room);
  }
}
