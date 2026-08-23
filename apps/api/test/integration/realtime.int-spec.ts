import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { TicketService } from '../../src/realtime/ticket.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { SequencerService } from '../../src/realtime/sequencer.service';
import { TimerService } from '../../src/realtime/timer.service';
import { ClientEvent, Rooms, ServerEvent } from '../../src/realtime/realtime.types';
import { uuidv7 } from '../../src/platform/ids/uuid-v7';
import { ensureMigrated, testPool } from './db';

/**
 * Two independent Nest applications stand in for two server instances behind a load
 * balancer. The important scenario is a client that connects to one, loses its
 * connection, and resumes against the *other* — which only works because sequencing and
 * the replay buffer live in Redis rather than in a process.
 */
describe('realtime (integration)', () => {
  let instanceA: INestApplication;
  let instanceB: INestApplication;
  let portA: number;
  let portB: number;
  let pool: Pool;
  let userId: string;
  let sessionId: string;

  async function boot(): Promise<{ app: INestApplication; port: number }> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    const url = await app.getUrl();
    return { app, port: Number(new URL(url.replace('[::1]', '127.0.0.1')).port) };
  }

  async function ticketFor(app: INestApplication): Promise<string> {
    const tickets = app.get(TicketService);
    const { ticket } = await tickets.issue({ userId, sessionId });
    return ticket;
  }

  function connect(port: number, ticket: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${port}/game`, {
      transports: ['websocket'],
      auth: { ticket },
      reconnection: false,
      forceNew: true,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 8000);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /** Waits for the socket to be disconnected by the server. */
  function expectDisconnect(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('expected a disconnect')), 8000);
      socket.on('disconnect', (reason) => {
        clearTimeout(timer);
        resolve(reason);
      });
    });
  }

  function collectEvents(socket: Socket): { events: Array<{ seq: number; type: string }> } {
    const collected: Array<{ seq: number; type: string }> = [];
    socket.on(ServerEvent.EVENT, (envelope: { seq: number; type: string }) => {
      collected.push({ seq: envelope.seq, type: envelope.type });
    });
    return { events: collected };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  /**
   * Creates a match with `userId` on the roster.
   *
   * Since P7 a match room may only be joined by its participants, so these tests need a
   * real roster rather than an arbitrary id — which is the point of the check.
   */
  async function matchWithUser(): Promise<string> {
    const matchId = uuidv7();
    await pool.query(
      `INSERT INTO game.matches (id, game_code, game_version, status) VALUES ($1, 'coin-duel', 1, 'in_progress')`,
      [matchId],
    );
    await pool.query(
      'INSERT INTO game.match_players (match_id, user_id, seat, stake) VALUES ($1, $2, 0, 0)',
      [matchId, userId],
    );
    return matchId;
  }

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);

    userId = uuidv7();
    await pool.query(
      `INSERT INTO auth.users (id, email, display_name) VALUES ($1, $2, 'Realtime Test')`,
      [userId, `rt-${userId}@example.test`],
    );
    sessionId = uuidv7();
    await pool.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [sessionId, userId]);

    ({ app: instanceA, port: portA } = await boot());
    ({ app: instanceB, port: portB } = await boot());
  }, 60_000);

  afterAll(async () => {
    await instanceA?.close();
    await instanceB?.close();
    await pool.end();
  });

  describe('ticket authentication', () => {
    it('connects with a valid ticket', async () => {
      const socket = await connect(portA, await ticketFor(instanceA));
      expect(socket.connected).toBe(true);
      socket.disconnect();
    });

    it('REFUSES a replayed ticket — tickets are single-use', async () => {
      const ticket = await ticketFor(instanceA);
      const first = await connect(portA, ticket);
      expect(first.connected).toBe(true);

      await expect(connect(portA, ticket)).rejects.toBeDefined();
      first.disconnect();
    });

    it('refuses an unknown ticket', async () => {
      await expect(connect(portA, 'not-a-real-ticket')).rejects.toBeDefined();
    });

    it('refuses a ticket whose session has been revoked', async () => {
      const revokedSession = uuidv7();
      await pool.query(
        'INSERT INTO auth.sessions (id, user_id, revoked_at) VALUES ($1, $2, now())',
        [revokedSession, userId],
      );
      const tickets = instanceA.get(TicketService);
      const { ticket } = await tickets.issue({ userId, sessionId: revokedSession });

      await expect(connect(portA, ticket)).rejects.toBeDefined();
    });
  });

  describe('rooms and authorisation', () => {
    it('joins a match room and reports the current sequence', async () => {
      const socket = await connect(portA, await ticketFor(instanceA));
      const matchId = await matchWithUser();
      const ack = await socket.emitWithAck(ClientEvent.JOIN, { room: Rooms.match(matchId) });

      expect(ack.ok).toBe(true);
      expect(ack.room).toBe(Rooms.match(matchId));
      expect(typeof ack.seq).toBe('number');
      socket.disconnect();
    });

    it("REFUSES to join another player's user room", async () => {
      const socket = await connect(portA, await ticketFor(instanceA));
      const ack = await socket.emitWithAck(ClientEvent.JOIN, { room: Rooms.user(uuidv7()) });

      // The client asking is exactly the case the check exists for (rule 1).
      expect(ack.ok).toBe(false);
      expect(ack.error).toBe('forbidden');
      socket.disconnect();
    });

    it('REFUSES a match room the player is not a participant of (P7)', async () => {
      const socket = await connect(portA, await ticketFor(instanceA));

      // A match that exists, with a roster this user is not on. Before P7 this was
      // permitted — any authenticated player could watch any match.
      const strangersMatch = uuidv7();
      const stranger = uuidv7();
      await pool.query(
        `INSERT INTO auth.users (id, email, display_name) VALUES ($1, $2, 'Stranger')`,
        [stranger, `stranger-${stranger}@example.test`],
      );
      await pool.query(
        `INSERT INTO game.matches (id, game_code, game_version, status) VALUES ($1, 'coin-duel', 1, 'in_progress')`,
        [strangersMatch],
      );
      await pool.query(
        'INSERT INTO game.match_players (match_id, user_id, seat, stake) VALUES ($1, $2, 0, 0)',
        [strangersMatch, stranger],
      );

      const ack = await socket.emitWithAck(ClientEvent.JOIN, { room: Rooms.match(strangersMatch) });
      expect(ack.ok).toBe(false);
      expect(ack.error).toBe('forbidden');
      socket.disconnect();
    });

    it('refuses malformed room names', async () => {
      const socket = await connect(portA, await ticketFor(instanceA));
      for (const room of ['', 'nonsense', 'match:../../etc', 'match:' + 'x'.repeat(200)]) {
        const ack = await socket.emitWithAck(ClientEvent.JOIN, { room });
        expect(ack.ok).toBe(false);
      }
      socket.disconnect();
    });

    it('disconnects a socket whose session is revoked mid-connection', async () => {
      const liveSession = uuidv7();
      await pool.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [liveSession, userId]);
      const { ticket } = await instanceA.get(TicketService).issue({ userId, sessionId: liveSession });
      const socket = await connect(portA, ticket);

      await pool.query('UPDATE auth.sessions SET revoked_at = now() WHERE id = $1', [liveSession]);

      // A revoked session must not keep playing just because it already holds a socket.
      // The ack may never arrive — the server disconnects as part of refusing — so the
      // disconnect itself is the assertion, not the ack.
      const disconnected = expectDisconnect(socket);
      const ack = await socket
        .emitWithAck(ClientEvent.JOIN, { room: Rooms.match(await matchWithUser()) })
        .catch(() => ({ ok: false }));
      expect(ack.ok).toBe(false);
      await expect(disconnected).resolves.toBeDefined();
    });
  });

  describe('sequenced delivery', () => {
    it('delivers events in order with monotonic sequence numbers', async () => {
      const socket = await connect(portA, await ticketFor(instanceA));
      const room = Rooms.match(await matchWithUser());
      await socket.emitWithAck(ClientEvent.JOIN, { room });
      const collector = collectEvents(socket);

      const realtime = instanceA.get(RealtimeService);
      for (let i = 1; i <= 5; i++) {
        await realtime.broadcast(room, 'test:tick', { i });
      }
      await settle();

      expect(collector.events).toHaveLength(5);
      const seqs = collector.events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(5);
      socket.disconnect();
    });

    it('reaches a socket held by ANOTHER instance (redis adapter)', async () => {
      const socket = await connect(portB, await ticketFor(instanceB));
      const room = Rooms.match(await matchWithUser());
      await socket.emitWithAck(ClientEvent.JOIN, { room });
      const collector = collectEvents(socket);

      // Broadcast from instance A to a socket connected to instance B.
      await instanceA.get(RealtimeService).broadcast(room, 'test:cross-instance', { hello: true });
      await settle();

      expect(collector.events.map((e) => e.type)).toContain('test:cross-instance');
      socket.disconnect();
    });
  });

  describe('resume protocol', () => {
    it('replays exactly the missed events after a reconnect', async () => {
      const room = Rooms.match(await matchWithUser());
      const first = await connect(portA, await ticketFor(instanceA));
      await first.emitWithAck(ClientEvent.JOIN, { room });
      const before = collectEvents(first);

      const realtime = instanceA.get(RealtimeService);
      await realtime.broadcast(room, 'test:before', { n: 1 });
      await settle();
      const lastSeq = before.events.at(-1)!.seq;

      // Client drops.
      first.disconnect();
      await settle();

      // Three events happen while it is away.
      for (let i = 0; i < 3; i++) await realtime.broadcast(room, 'test:missed', { i });

      const second = await connect(portA, await ticketFor(instanceA));
      const after = collectEvents(second);
      const ack = await second.emitWithAck(ClientEvent.RESUME, { room, lastSeq });
      await settle();

      expect(ack.ok).toBe(true);
      expect(ack.resync).toBeFalsy();
      expect(ack.replayed).toBe(3);
      expect(after.events.map((e) => e.seq)).toEqual([lastSeq + 1, lastSeq + 2, lastSeq + 3]);
      second.disconnect();
    });

    it('RESUMES AGAINST A DIFFERENT INSTANCE than the one that sent the events', async () => {
      const room = Rooms.match(await matchWithUser());
      const onA = await connect(portA, await ticketFor(instanceA));
      await onA.emitWithAck(ClientEvent.JOIN, { room });
      const beforeDrop = collectEvents(onA);

      await instanceA.get(RealtimeService).broadcast(room, 'test:first', { n: 0 });
      await settle();
      const lastSeq = beforeDrop.events.at(-1)!.seq;
      onA.disconnect();
      await settle();

      await instanceA.get(RealtimeService).broadcast(room, 'test:while-away', { n: 1 });
      await instanceA.get(RealtimeService).broadcast(room, 'test:while-away', { n: 2 });

      // Reconnect to instance B — the state a load balancer would produce.
      const onB = await connect(portB, await ticketFor(instanceB));
      const afterReconnect = collectEvents(onB);
      const ack = await onB.emitWithAck(ClientEvent.RESUME, { room, lastSeq });
      await settle();

      expect(ack.replayed).toBe(2);
      expect(afterReconnect.events.map((e) => e.seq)).toEqual([lastSeq + 1, lastSeq + 2]);
      onB.disconnect();
    });

    it('demands a full resync when the gap is larger than the buffer', async () => {
      const room = Rooms.match(await matchWithUser());
      const socket = await connect(portA, await ticketFor(instanceA));

      // Advance the room far beyond what the ring buffer retains.
      const sequencer = instanceA.get(SequencerService);
      for (let i = 0; i < SequencerService.bufferSize + 20; i++) {
        await sequencer.record(room, 'test:noise', { i });
      }

      const ack = await socket.emitWithAck(ClientEvent.RESUME, { room, lastSeq: 1 });
      // Silently sending a partial gap would leave the client inconsistent without
      // either side knowing — so the answer is an explicit resync instruction.
      expect(ack.resync).toBe(true);
      socket.disconnect();
    });

    it('demands a resync when the client is AHEAD of the server (post-flush)', async () => {
      const room = Rooms.match(await matchWithUser());
      const socket = await connect(portA, await ticketFor(instanceA));
      await socket.emitWithAck(ClientEvent.JOIN, { room });

      const ack = await socket.emitWithAck(ClientEvent.RESUME, { room, lastSeq: 999_999 });
      expect(ack.resync).toBe(true);
      socket.disconnect();
    });

    it('replays nothing when the client is already current', async () => {
      const room = Rooms.match(await matchWithUser());
      const socket = await connect(portA, await ticketFor(instanceA));
      await socket.emitWithAck(ClientEvent.JOIN, { room });
      await instanceA.get(RealtimeService).broadcast(room, 'test:one', {});
      await settle();

      const current = await instanceA.get(SequencerService).currentSeq(room);
      const ack = await socket.emitWithAck(ClientEvent.RESUME, { room, lastSeq: current });
      expect(ack.replayed).toBe(0);
      expect(ack.resync).toBeFalsy();
      socket.disconnect();
    });
  });

  describe('server-authoritative timers', () => {
    it('fires a scheduled deadline and reports remaining time', async () => {
      const timers = instanceA.get(TimerService);
      let fired = false;
      const handle = timers.schedule('test-timer', 120, () => {
        fired = true;
      });

      expect(handle.deadlineAt).toBeGreaterThan(Date.now());
      expect(timers.remaining('test-timer')).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(fired).toBe(true);
      expect(timers.remaining('test-timer')).toBeNull();
    });

    it('cancels a timer so it never fires', async () => {
      const timers = instanceA.get(TimerService);
      let fired = false;
      timers.schedule('cancel-me', 100, () => {
        fired = true;
      });
      expect(timers.cancel('cancel-me')).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fired).toBe(false);
    });

    it('replaces a timer scheduled twice with the same id', async () => {
      const timers = instanceA.get(TimerService);
      let count = 0;
      timers.schedule('dup', 80, () => {
        count++;
      });
      timers.schedule('dup', 80, () => {
        count++;
      });

      await new Promise((resolve) => setTimeout(resolve, 220));
      // Rescheduling a turn deadline must not leave the old one armed.
      expect(count).toBe(1);
    });

    it('survives a throwing expiry handler', async () => {
      const timers = instanceA.get(TimerService);
      timers.schedule('boom', 50, () => {
        throw new Error('handler exploded');
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(timers.remaining('boom')).toBeNull();
    });
  });
});
