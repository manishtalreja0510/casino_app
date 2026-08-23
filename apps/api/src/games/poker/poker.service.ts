import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { Inject } from '@nestjs/common';
import { PG_POOL } from '../../platform/database/database.module';
import { withTransaction } from '../../platform/database/transaction';
import { FlagsService } from '../../platform/flags/flags.service';
import { gameEnabledKey } from '../../platform/flags/flag-keys';
import { uuidv7 } from '../../platform/ids/uuid-v7';
import { EngineService, type MatchChange } from '../../game-engine/engine.service';
import { MatchRepository } from '../../game-engine/match.repository';
import { MatchmakingRepository } from '../../matchmaking/matchmaking.repository';
import { RealtimeService } from '../../realtime/realtime.service';
import { TimerService } from '../../realtime/timer.service';
import { WalletService } from '../../wallet/wallet.service';
import { RoundLeaderService } from '../crash/round-leader.service';
import { PokerRepository, type PokerSeat, type PokerTable } from './poker.repository';
import { parsePokerConfig } from './poker.config';
import type { PokerResult } from './poker.game';
import {
  AlreadySeatedError,
  BuyInOutOfBoundsError,
  MidHandError,
  NotSeatedError,
  TableFullError,
  TableUnavailableError,
  TooManyTablesError,
} from './poker.errors';

export const POKER_GAME_CODE = 'poker';

/** How often the watchdog looks for a table that should be dealing and is not. */
const WATCHDOG_MS = 4_000;

/** Pause between hands, so players can see the result before the next deal. */
const INTER_HAND_MS = 4_000;

/** Tables one player may sit at simultaneously (`poker.md §13`). */
const MAX_TABLES_PER_USER = 4;

/** Room carrying a table's public life. */
export function tableRoom(tableId: string): string {
  return `round:table-${tableId}`;
}

/**
 * Tables, seats and the deal loop (`docs/02-domains/poker.md §3`, ADR-025).
 *
 * The division of labour: `poker.game.ts` knows the rules of a hand and nothing else; this
 * service knows who is sitting, whose chips are whose, and when to deal. The chips a hand
 * moves are game state — the money behind them sits in the table's escrow from sit-down to
 * stand-up, and a hand's only ledger movement is rake.
 *
 * Everything that depends on who is at the table happens under the table row lock. Seat
 * numbers, the dealt set and the button are all read-then-write otherwise, and a race in
 * any of them puts someone in a hand they did not join.
 */
@Injectable()
export class PokerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PokerService.name);

  private watchdog?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly engine: EngineService,
    private readonly matches: MatchRepository,
    private readonly tables: PokerRepository,
    private readonly tiers: MatchmakingRepository,
    private readonly wallet: WalletService,
    private readonly realtime: RealtimeService,
    private readonly timers: TimerService,
    private readonly flags: FlagsService,
    private readonly leader: RoundLeaderService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.engine.onMatchChanged((change) => this.onMatchChanged(change));

    if (!this.config.get<boolean>('SCHEDULED_WORK_ENABLED', true)) {
      this.logger.log('poker deal loop disabled for this instance (SCHEDULED_WORK_ENABLED=false)');
      return;
    }

    this.watchdog = setInterval(() => void this.sweep(), WATCHDOG_MS);
    this.watchdog.unref?.();
    void this.sweep();
  }

  onApplicationShutdown(): void {
    this.stopping = true;
    if (this.watchdog) clearInterval(this.watchdog);
  }

  // --- table lifecycle -----------------------------------------------------

  /** Makes sure every enabled poker tier has a table, then deals where it can. */
  async sweep(): Promise<void> {
    if (this.stopping) return;
    try {
      if (!(await this.flags.isEnabled(gameEnabledKey(POKER_GAME_CODE)))) return;

      for (const tier of await this.tiers.listTiers(POKER_GAME_CODE)) {
        await this.ensureTable(tier.id, tier.name, tier.config, tier.currency);
      }
      for (const table of await this.tables.listTables()) {
        await this.dealIfReady(table);
      }
    } catch (error) {
      this.logger.warn(`poker sweep failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  /** One open table per tier for now; more tables per tier is a P12 admin concern. */
  private async ensureTable(
    tierId: string,
    name: string,
    tierConfig: Record<string, unknown>,
    currency: string,
  ): Promise<void> {
    const existing = await this.tables.listTables(tierId);
    if (existing.length > 0) return;

    const { config, error } = parsePokerConfig(tierConfig);
    if (error) {
      // A table whose configuration will not parse would run on the fallback — no rake and
      // 1/2 blinds — which is not the table anyone configured. Refuse to open it.
      this.logger.error(`tier ${tierId} has invalid poker config (${error}); no table opened`);
      return;
    }

    const seats = Number((tierConfig as { seats?: unknown }).seats ?? 6);
    const id = await this.tables.createTable({
      tierId,
      name,
      seatCount: Math.min(Math.max(seats, 2), 6),
      currency,
      config: { ...config, seats },
    });
    this.logger.log(`opened poker table ${id} for tier ${tierId}`);
  }

  // --- seats ---------------------------------------------------------------

  /**
   * Sits a player down with a buy-in.
   *
   * The seat and the money commit together (`wallet.sitDown` joins this transaction): a
   * seat without a buy-in is a player with chips they never paid for, and a buy-in without
   * a seat is money taken for a chair they never got.
   */
  async sit(input: {
    userId: string;
    tableId: string;
    buyIn: number;
    seatNo?: number;
  }): Promise<{ seatNo: number; stack: number }> {
    await this.requireEnabled();

    const elsewhere = await this.tables.seatsOf(input.userId);
    if (elsewhere.filter((seat) => seat.tableId !== input.tableId).length >= MAX_TABLES_PER_USER) {
      throw new TooManyTablesError(MAX_TABLES_PER_USER);
    }

    return withTransaction(this.pool, async (client) => {
      const table = await this.tables.lockTable(client, input.tableId);
      if (!table || table.status !== 'open') throw new TableUnavailableError();

      const { config } = parsePokerConfig(table.config);
      if (
        !Number.isSafeInteger(input.buyIn) ||
        input.buyIn < config.buyIn.min ||
        input.buyIn > config.buyIn.max
      ) {
        throw new BuyInOutOfBoundsError(config.buyIn.min, config.buyIn.max);
      }

      const seats = await this.tables.listSeats(input.tableId, client);
      if (seats.some((seat) => seat.userId === input.userId)) throw new AlreadySeatedError();
      if (seats.length >= table.seatCount) throw new TableFullError();

      const taken = new Set(seats.map((seat) => seat.seatNo));
      const seatNo =
        input.seatNo !== undefined && !taken.has(input.seatNo)
          ? input.seatNo
          : Array.from({ length: table.seatCount }, (_, i) => i).find((n) => !taken.has(n))!;

      const seatSessionId = uuidv7();
      await this.tables.takeSeat(client, {
        tableId: input.tableId,
        seatNo,
        userId: input.userId,
        seatSessionId,
        stack: input.buyIn,
      });

      // Throws on insufficient funds, rolling the seat back with it.
      await this.wallet.sitDown(
        {
          userId: input.userId,
          tableId: input.tableId,
          seatSessionId,
          amount: input.buyIn,
          currency: table.currency,
        },
        client,
      );

      return { seatNo, stack: input.buyIn };
    });
  }

  /**
   * Stands a player up.
   *
   * Mid-hand this only *marks* the seat: the stack is still in play, and paying it out
   * before the hand finishes would let a player retrieve chips already committed to a pot.
   * The hand's settlement does the rest (`poker.md §11`).
   */
  async stand(userId: string, tableId: string): Promise<{ cashedOut: number | null }> {
    const activeHand = await this.tables.findActiveHand(tableId);

    return withTransaction(this.pool, async (client) => {
      const table = await this.tables.lockTable(client, tableId);
      if (!table) throw new TableUnavailableError();

      const seat = await this.tables.findSeatOf(tableId, userId, client);
      if (!seat) throw new NotSeatedError();

      if (activeHand) {
        const inHand = (await this.matches.listPlayers(activeHand)).some((p) => p.userId === userId);
        if (inHand) {
          await this.tables.setSeatState(client, tableId, userId, 'standing');
          return { cashedOut: null };
        }
      }

      await this.cashOutSeat(client, table, seat);
      return { cashedOut: seat.stack };
    });
  }

  /** Adds chips to a seat between hands, up to the table maximum. */
  async topUp(userId: string, tableId: string, amount: number): Promise<{ stack: number }> {
    await this.requireEnabled();
    if (await this.tables.findActiveHand(tableId)) throw new MidHandError('A top-up');

    return withTransaction(this.pool, async (client) => {
      const table = await this.tables.lockTable(client, tableId);
      if (!table || table.status !== 'open') throw new TableUnavailableError();

      const seat = await this.tables.findSeatOf(tableId, userId, client);
      if (!seat) throw new NotSeatedError();

      const { config } = parsePokerConfig(table.config);
      const target = seat.stack + amount;
      if (!Number.isSafeInteger(amount) || amount <= 0 || target > config.buyIn.max) {
        throw new BuyInOutOfBoundsError(1, config.buyIn.max - seat.stack);
      }

      await this.tables.setStack(client, tableId, userId, target);
      await this.wallet.sitDown(
        {
          userId,
          tableId,
          // A distinct key per top-up: the seat session already paid for its buy-in, and
          // reusing it would make the second charge a no-op replay.
          seatSessionId: `${seat.seatSessionId}:topup:${uuidv7()}`,
          amount,
          currency: table.currency,
        },
        client,
      );

      return { stack: target };
    });
  }

  /** Sits a player out or back in. Takes effect for the next deal, never mid-hand. */
  async setSittingOut(userId: string, tableId: string, sittingOut: boolean): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const seat = await this.tables.findSeatOf(tableId, userId, client);
      if (!seat) throw new NotSeatedError();
      if (seat.state === 'standing') throw new NotSeatedError();
      await this.tables.setSeatState(client, tableId, userId, sittingOut ? 'sitting_out' : 'seated');
    });
  }

  // --- dealing -------------------------------------------------------------

  /**
   * Deals a hand if the table is ready.
   *
   * The kill-switch is checked here and nowhere else in the loop, which is what makes it a
   * **drain**: a hand already in progress finishes normally and pays out, and only the next
   * deal fails to happen (rule 16).
   */
  async dealIfReady(table: PokerTable): Promise<string | null> {
    if (!(await this.leader.acquire(`poker:${table.id}`))) return null;
    if (await this.tables.findActiveHand(table.id)) return null;
    if (!(await this.flags.isEnabled(gameEnabledKey(POKER_GAME_CODE)))) return null;

    const { config } = parsePokerConfig(table.config);

    const prepared = await withTransaction(this.pool, async (client) => {
      const locked = await this.tables.lockTable(client, table.id);
      if (!locked || locked.status !== 'open') return null;

      const seats = await this.tables.listSeats(table.id, client);

      // Anyone who cannot cover the big blind cannot be dealt in; they sit out rather than
      // being dealt a hand they cannot play.
      for (const seat of seats) {
        if (seat.state === 'seated' && seat.stack < config.blinds.bb) {
          await this.tables.setSeatState(client, table.id, seat.userId, 'sitting_out');
        }
      }

      const dealt = seats.filter(
        (seat) => seat.state === 'seated' && seat.stack >= config.blinds.bb,
      );
      if (dealt.length < 2) return null;

      // The button moves to the next occupied seat each hand, and deal order runs from its
      // left — which is what makes the blinds land on the right people.
      const buttonSeat = nextOccupiedSeat(dealt, locked.buttonSeat, locked.handNo > 0);
      const order = dealOrder(dealt, buttonSeat);

      await this.tables.advanceTable(client, table.id, {
        buttonSeat,
        handNo: locked.handNo + 1,
      });

      return { table: locked, order, buttonSeat, handNo: locked.handNo + 1 };
    });

    if (!prepared) return null;

    // The match is created outside the table transaction on purpose: `createOpenMatch`
    // and `joinMatch` each take their own, and holding the table lock across them would
    // serialise every table in the process behind one deal.
    const { matchId } = await this.engine.createOpenMatch({
      gameCode: POKER_GAME_CODE,
      stake: 0,
      config: {
        ...config,
        tableId: table.id,
        handNo: prepared.handNo,
        // Seats are handed over in deal order — the button's left first — so the button
        // itself is last. The reducer takes this as an index into that array.
        buttonOrder: prepared.order.length - 1,
      },
    });

    for (const [index, seat] of prepared.order.entries()) {
      await this.engine.joinMatch({
        matchId,
        userId: seat.userId,
        // Zero: a poker hand takes no buy-in. The chips are already at the table.
        stake: 0,
        meta: { seat: seat.seatNo, order: index, stack: seat.stack },
      });
    }

    const started = await this.engine.startMatch(matchId);
    if (!started.started) {
      await this.engine.voidMatch(matchId, 'not enough players at the deal');
      return null;
    }

    await this.realtime.broadcast(tableRoom(table.id), 'poker:hand_started', {
      tableId: table.id,
      matchId,
      handNo: prepared.handNo,
      buttonSeat: prepared.buttonSeat,
      players: prepared.order.map((seat) => ({ userId: seat.userId, seat: seat.seatNo })),
    });

    return matchId;
  }

  /**
   * Reacts to a hand finishing: persist stacks, record the hand, then deal the next.
   *
   * The stacks come from the hand's own public view, which is the engine's authoritative
   * state — not from anything this service tracked alongside it. Two records of the same
   * chips is how they come to disagree.
   */
  private async onMatchChanged(change: MatchChange): Promise<void> {
    if (change.gameCode !== POKER_GAME_CODE) return;
    if (change.status !== 'settled' && change.status !== 'voided') return;

    try {
      const match = await this.matches.findMatch(change.matchId);
      if (!match) return;
      const tableId = String(match.config.tableId ?? '');
      if (!tableId) return;

      const view = (await this.engine.publicViewFor(change.matchId)) ?? {};
      const result = view.result as PokerResult | null | undefined;

      await withTransaction(this.pool, async (client) => {
        const table = await this.tables.lockTable(client, tableId);
        if (!table) return;

        const players = await this.matches.listPlayers(change.matchId);

        // A voided hand restores the stacks recorded at `init` (`poker.md §10`): the hand
        // never happened, so neither did the chips moving.
        const finalStacks =
          change.status === 'voided' || !result
            ? Object.fromEntries(
                players.map((p) => [p.userId, Number((p.meta as { stack?: number })?.stack ?? 0)]),
              )
            : result.stacks;

        for (const [userId, stack] of Object.entries(finalStacks)) {
          await this.tables.setStack(client, tableId, userId, Math.max(0, Math.round(stack)));
        }

        if (result) {
          await this.tables.recordHand(client, {
            matchId: change.matchId,
            tableId,
            handNo: Number(match.config.handNo ?? table.handNo),
            buttonSeat: table.buttonSeat,
            pot: result.pots.reduce((sum, pot) => sum + pot.amount, 0),
            rake: result.rake,
            board: (view.board as string[] | undefined) ?? [],
            summary: { awards: result.awards, shown: result.shown, returned: result.returned },
          });
        }

        // Anyone who asked to leave, or who has nothing left, goes now that the hand is over.
        const seats = await this.tables.listSeats(tableId, client);
        for (const seat of seats) {
          const stack = Math.max(0, Math.round(finalStacks[seat.userId] ?? seat.stack));
          if (seat.state === 'standing') {
            await this.cashOutSeat(client, table, { ...seat, stack });
          } else if (stack === 0) {
            // Busted. The seat is released rather than left holding nothing, so somebody
            // else can sit; the player can buy in again.
            await this.cashOutSeat(client, table, { ...seat, stack: 0 });
          }
        }
      });

      await this.realtime.broadcast(tableRoom(tableId), 'poker:hand_finished', {
        tableId,
        matchId: change.matchId,
        status: change.status,
        ...(result ? { awards: result.awards, shown: result.shown, rake: result.rake } : {}),
      });

      // Pause, then deal again. Scheduled rather than slept so shutdown is not held up,
      // and backed by the watchdog if this instance disappears first.
      this.timers.schedule(`poker-next:${tableId}`, INTER_HAND_MS, async () => {
        const table = await this.tables.findTable(tableId);
        if (table) await this.dealIfReady(table);
      });
    } catch (error) {
      this.logger.error(
        `poker hand ${change.matchId} post-processing failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /** Returns a stack to its owner's wallet and frees the seat. */
  private async cashOutSeat(
    client: Parameters<typeof this.tables.removeSeat>[0],
    table: PokerTable,
    seat: PokerSeat,
  ): Promise<void> {
    await this.tables.removeSeat(client, table.id, seat.userId);
    await this.wallet.standUp(
      {
        userId: seat.userId,
        tableId: table.id,
        seatSessionId: seat.seatSessionId,
        amount: seat.stack,
        currency: table.currency,
      },
      client,
    );
  }

  // --- reads ---------------------------------------------------------------

  /** A table as a client renders it: seats, the live hand, recent history. */
  async tableView(tableId: string, userId?: string): Promise<Record<string, unknown>> {
    const table = await this.tables.findTable(tableId);
    if (!table) throw new TableUnavailableError();

    const { config } = parsePokerConfig(table.config);
    const seats = await this.tables.listSeats(tableId);
    const matchId = await this.tables.findActiveHand(tableId);

    // A seated player gets their own view of the hand — the only path their cards take.
    // Anyone else gets the public one.
    const hand = matchId
      ? userId && seats.some((seat) => seat.userId === userId)
        ? ((await this.engine.viewFor(matchId, userId).catch(() => null))?.view ?? null)
        : ((await this.engine.publicViewFor(matchId).catch(() => null)) ?? null)
      : null;

    return {
      tableId,
      name: table.name,
      tierId: table.tierId,
      seatCount: table.seatCount,
      currency: table.currency,
      blinds: config.blinds,
      buyIn: config.buyIn,
      room: tableRoom(tableId),
      buttonSeat: table.buttonSeat,
      handNo: table.handNo,
      matchId,
      seats: seats.map((seat) => ({
        seatNo: seat.seatNo,
        userId: seat.userId,
        stack: seat.stack,
        state: seat.state,
      })),
      hand,
      history: await this.tables.recentHands(tableId, 10),
    };
  }

  async listTables(): Promise<Array<Record<string, unknown>>> {
    const tables = await this.tables.listTables();
    const out: Array<Record<string, unknown>> = [];

    for (const table of tables) {
      const { config } = parsePokerConfig(table.config);
      const seats = await this.tables.listSeats(table.id);
      out.push({
        tableId: table.id,
        name: table.name,
        tierId: table.tierId,
        blinds: config.blinds,
        buyIn: config.buyIn,
        seatCount: table.seatCount,
        seated: seats.length,
        currency: table.currency,
      });
    }
    return out;
  }

  /** Forwards a player's action to the engine. Nothing about it is decided here. */
  async act(userId: string, tableId: string, action: { type: string; amount?: number }): Promise<void> {
    const matchId = await this.tables.findActiveHand(tableId);
    if (!matchId) throw new NotSeatedError();

    await this.engine.submitAction(matchId, {
      type: action.type,
      userId,
      ...(action.amount === undefined ? {} : { payload: { amount: action.amount } }),
    });
  }

  private async requireEnabled(): Promise<void> {
    if (!(await this.flags.isEnabled(gameEnabledKey(POKER_GAME_CODE)))) {
      throw new TableUnavailableError();
    }
  }
}

/** The next occupied seat clockwise from `from`, wrapping. */
function nextOccupiedSeat(seats: readonly PokerSeat[], from: number, advance: boolean): number {
  const numbers = seats.map((seat) => seat.seatNo).sort((a, b) => a - b);
  if (numbers.length === 0) return from;
  if (!advance) return numbers.find((n) => n >= from) ?? numbers[0]!;
  return numbers.find((n) => n > from) ?? numbers[0]!;
}

/**
 * Seats in deal order: the button's left first, the button last.
 *
 * That ordering is not cosmetic — it is what puts the blinds on the right players and
 * decides who receives the odd chip of a split pot.
 */
function dealOrder(seats: readonly PokerSeat[], buttonSeat: number): PokerSeat[] {
  const sorted = [...seats].sort((a, b) => a.seatNo - b.seatNo);
  const buttonIndex = sorted.findIndex((seat) => seat.seatNo === buttonSeat);
  if (buttonIndex < 0) return sorted;
  return [...sorted.slice(buttonIndex + 1), ...sorted.slice(0, buttonIndex + 1)];
}
