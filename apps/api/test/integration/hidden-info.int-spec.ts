import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { EngineService } from '../../src/game-engine/engine.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { TicketService } from '../../src/realtime/ticket.service';
import { ClientEvent, Rooms, ServerEvent } from '../../src/realtime/realtime.types';
import { uuidv7 } from '../../src/platform/ids/uuid-v7';
import { ensureMigrated, testPool } from './db';

interface Envelope {
  seq: number;
  type: string;
  room: string;
  payload: Record<string, unknown>;
}

interface Player {
  userId: string;
  sessionId: string;
  socket: Socket;
  received: Envelope[];
}

/**
 * Adversarial protocol tests for hidden information (P9 prerequisite).
 *
 * The live case is easy and was never the risk. The risk is **resume**: sequencing and the
 * replay buffer are per room, so anything delivered into a shared room can be replayed to
 * anyone who reconnects into it — long after the moment it was "addressed" to one player.
 * A leak of that shape passes every live test and shows up only when someone's train goes
 * into a tunnel.
 *
 * So these tests do the thing an attacker would: reconnect and ask for everything from
 * sequence zero, on every room reachable, and check that another player's secret is not in
 * the answer. `coin-duel` is the subject because it has exactly poker's shape — a value
 * that is private until the game reveals it — without needing poker to exist yet.
 */
describe('hidden information (integration)', () => {
  let app: INestApplication;
  let port: number;
  let pool: Pool;
  let engine: EngineService;

  let alice: Player;
  let bob: Player;

  async function makeUser(): Promise<{ userId: string; sessionId: string }> {
    const userId = uuidv7();
    await pool.query(
      `INSERT INTO auth.users (id, email, display_name) VALUES ($1, $2, 'Hidden Info Test')`,
      [userId, `hidden-${userId}@example.test`],
    );
    const sessionId = uuidv7();
    await pool.query('INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)', [sessionId, userId]);
    return { userId, sessionId };
  }

  async function connect(identity: { userId: string; sessionId: string }): Promise<Player> {
    const { ticket } = await app.get(TicketService).issue(identity);
    const socket = io(`http://127.0.0.1:${port}/game`, {
      transports: ['websocket'],
      auth: { ticket },
      reconnection: false,
      forceNew: true,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 8_000);
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const received: Envelope[] = [];
    socket.on(ServerEvent.EVENT, (envelope: Envelope) => received.push(envelope));
    return { ...identity, socket, received };
  }

  function emit<T>(socket: Socket, event: string, body: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 8_000);
      socket.emit(event, body, (ack: T) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  /** Everything a player has been sent, as one searchable string. */
  const transcriptOf = (player: Player) => JSON.stringify(player.received);

  beforeAll(async () => {
    pool = testPool();
    await ensureMigrated(pool);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    port = Number(new URL((await app.getUrl()).replace('[::1]', '127.0.0.1')).port);

    engine = app.get(EngineService);

    alice = await connect(await makeUser());
    bob = await connect(await makeUser());
  }, 60_000);

  afterAll(async () => {
    alice?.socket.disconnect();
    bob?.socket.disconnect();
    await app?.close();
    await pool?.end();
  });

  /** A free-play match with both players seated, and both sockets in its room. */
  async function seatedMatch(): Promise<string> {
    const { matchId } = await engine.createMatch({
      gameCode: 'coin-duel',
      players: [{ userId: alice.userId }, { userId: bob.userId }],
      stake: 0,
    });

    for (const player of [alice, bob]) {
      const ack = await emit<{ ok: boolean }>(player.socket, ClientEvent.JOIN, {
        room: Rooms.match(matchId),
      });
      expect(ack.ok).toBe(true);
      player.received.length = 0;
    }

    return matchId;
  }

  describe('live delivery', () => {
    it("sends a private event only to its owner, and the public one to both", async () => {
      const matchId = await seatedMatch();

      await engine.submitAction(matchId, {
        type: 'pick',
        userId: alice.userId,
        payload: { choice: 'heads' },
      });
      await settle();

      // The fact of a pick is public…
      expect(alice.received.some((e) => e.type === 'player:picked')).toBe(true);
      expect(bob.received.some((e) => e.type === 'player:picked')).toBe(true);

      // …the pick itself is not.
      expect(alice.received.some((e) => e.type === 'your:pick')).toBe(true);
      expect(bob.received.some((e) => e.type === 'your:pick')).toBe(false);
      expect(transcriptOf(bob)).not.toContain('heads');
    });

    it('routes a private event to its owner’s room, never to the shared one', async () => {
      const matchId = await seatedMatch();

      await engine.submitAction(matchId, {
        type: 'pick',
        userId: alice.userId,
        payload: { choice: 'tails' },
      });
      await settle();

      const privateEvent = alice.received.find((e) => e.type === 'your:pick');
      expect(privateEvent).toBeDefined();

      // The room is the mechanism: a one-member room has its own sequence and its own
      // replay buffer, so there is no shared buffer for this to end up in.
      expect(privateEvent!.room).toBe(Rooms.user(alice.userId));
      expect(privateEvent!.room).not.toBe(Rooms.match(matchId));

      const publicEvent = alice.received.find((e) => e.type === 'player:picked');
      expect(publicEvent!.room).toBe(Rooms.match(matchId));
    });

    it('stamps every event with the match sequence, so two streams can be ordered', async () => {
      const matchId = await seatedMatch();

      await engine.submitAction(matchId, {
        type: 'pick',
        userId: alice.userId,
        payload: { choice: 'heads' },
      });
      await settle();

      // A player now receives one match on two room sequences. Without a shared ordering
      // key, "you were dealt X" and "the betting round opened" arrive with no defined
      // order — which for poker is the difference between a coherent table and a race.
      for (const type of ['player:picked', 'your:pick']) {
        const event = alice.received.find((e) => e.type === type);
        expect(typeof event!.payload.matchSeq).toBe('number');
      }

      const publicSeq = alice.received.find((e) => e.type === 'player:picked')!.payload.matchSeq;
      const privateSeq = alice.received.find((e) => e.type === 'your:pick')!.payload.matchSeq;
      expect(publicSeq).toBe(privateSeq);
    });
  });

  describe('resume — the path a leak would actually take', () => {
    it('replays nothing of another player’s secret, asking from sequence zero', async () => {
      const matchId = await seatedMatch();

      await engine.submitAction(matchId, {
        type: 'pick',
        userId: alice.userId,
        payload: { choice: 'heads' },
      });
      await settle();

      // Bob reconnects and asks for everything the server will give him, on every room he
      // is entitled to — which is exactly what an attacker would send.
      bob.socket.disconnect();
      bob = await connect({ userId: bob.userId, sessionId: bob.sessionId });

      for (const room of [Rooms.match(matchId), Rooms.user(bob.userId)]) {
        const ack = await emit<{ ok: boolean; resync?: boolean }>(bob.socket, ClientEvent.RESUME, {
          room,
          lastSeq: 0,
        });
        expect(ack.ok).toBe(true);
      }
      await settle();

      expect(bob.received.some((e) => e.type === 'your:pick')).toBe(false);
      expect(transcriptOf(bob)).not.toContain('heads');
    });

    it('refuses to resume another player’s room at all', async () => {
      const matchId = await seatedMatch();
      await engine.submitAction(matchId, {
        type: 'pick',
        userId: alice.userId,
        payload: { choice: 'tails' },
      });
      await settle();

      const resumed = await emit<{ ok: boolean; error?: string }>(bob.socket, ClientEvent.RESUME, {
        room: Rooms.user(alice.userId),
        lastSeq: 0,
      });
      expect(resumed).toEqual({ ok: false, error: 'forbidden' });

      const joined = await emit<{ ok: boolean; error?: string }>(bob.socket, ClientEvent.JOIN, {
        room: Rooms.user(alice.userId),
      });
      expect(joined).toEqual({ ok: false, error: 'forbidden' });

      await settle();
      expect(transcriptOf(bob)).not.toContain('tails');
    });

    it('refuses a match room the caller is not seated in', async () => {
      const outsider = await connect(await makeUser());
      const matchId = await seatedMatch();

      const ack = await emit<{ ok: boolean; error?: string }>(outsider.socket, ClientEvent.JOIN, {
        room: Rooms.match(matchId),
      });
      expect(ack).toEqual({ ok: false, error: 'forbidden' });

      outsider.socket.disconnect();
    });
  });

  describe('what the engine refuses to deliver', () => {
    it('drops a private event addressed to someone outside the match', async () => {
      const matchId = await seatedMatch();
      const outsider = await connect(await makeUser());

      // A game reaching for a user id that is not on its roster is a bug; the realtime
      // layer refuses rather than trusting the game to be right about who may see what.
      await app.get(RealtimeService).deliver(
        matchId,
        [{ type: 'leak:attempt', payload: { secret: 'ace-of-spades' }, onlyTo: [outsider.userId] }],
        { matchSeq: 99, participants: [alice.userId, bob.userId] },
      );
      await settle();

      expect(transcriptOf(outsider)).not.toContain('ace-of-spades');
      expect(outsider.received.some((e) => e.type === 'leak:attempt')).toBe(false);

      outsider.socket.disconnect();
    });

    it('delivers an empty recipient list to nobody, rather than to everybody', async () => {
      const matchId = await seatedMatch();
      // The dangerous default. A game that computes "who may see this" and gets an empty
      // answer must not have that treated as "everyone" — which is what `onlyTo ?? []`
      // followed by a length check would do.
      await app.get(RealtimeService).deliver(
        matchId,
        [{ type: 'hole:cards', payload: { cards: ['As', 'Kd'] }, onlyTo: [] }],
        { matchSeq: 100, participants: [alice.userId, bob.userId] },
      );
      await settle();

      for (const player of [alice, bob]) {
        expect(transcriptOf(player)).not.toContain('As');
        expect(player.received.some((e) => e.type === 'hole:cards')).toBe(false);
      }
    });
  });
});
