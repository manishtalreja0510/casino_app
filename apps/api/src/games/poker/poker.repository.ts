import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../platform/database/database.module';
import { uuidv7 } from '../../platform/ids/uuid-v7';

export interface PokerTable {
  id: string;
  tierId: string;
  name: string;
  seatCount: number;
  currency: string;
  config: Record<string, unknown>;
  status: 'open' | 'closing' | 'closed';
  buttonSeat: number;
  handNo: number;
}

export interface PokerSeat {
  tableId: string;
  seatNo: number;
  userId: string;
  seatSessionId: string;
  stack: number;
  state: 'seated' | 'sitting_out' | 'standing';
}

/** The only place `poker.*` tables are read or written (rule 20). */
@Injectable()
export class PokerRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async createTable(input: {
    tierId: string;
    name: string;
    seatCount: number;
    currency: string;
    config: Record<string, unknown>;
  }): Promise<string> {
    const id = uuidv7();
    await this.pool.query(
      `INSERT INTO poker.tables (id, tier_id, name, seat_count, currency, config)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.tierId, input.name, input.seatCount, input.currency, JSON.stringify(input.config)],
    );
    return id;
  }

  async listTables(tierId?: string): Promise<PokerTable[]> {
    const { rows } = await this.pool.query(
      `SELECT id, tier_id, name, seat_count, currency, config, status, button_seat, hand_no
         FROM poker.tables
        WHERE status = 'open' AND ($1::text IS NULL OR tier_id = $1)
        ORDER BY created_at`,
      [tierId ?? null],
    );
    return rows.map(PokerRepository.toTable);
  }

  async findTable(id: string, client?: PoolClient): Promise<PokerTable | null> {
    const { rows } = await (client ?? this.pool).query(
      `SELECT id, tier_id, name, seat_count, currency, config, status, button_seat, hand_no
         FROM poker.tables WHERE id = $1`,
      [id],
    );
    return rows[0] ? PokerRepository.toTable(rows[0]) : null;
  }

  /**
   * Locks the table row.
   *
   * Every decision that depends on who is sitting — seating someone, dealing a hand,
   * paying someone out — is made under this lock. Seat numbers, the dealt set and the
   * button are otherwise all read-then-write races.
   */
  async lockTable(client: PoolClient, id: string): Promise<PokerTable | null> {
    const { rows } = await client.query(
      `SELECT id, tier_id, name, seat_count, currency, config, status, button_seat, hand_no
         FROM poker.tables WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ? PokerRepository.toTable(rows[0]) : null;
  }

  async listSeats(tableId: string, client?: PoolClient): Promise<PokerSeat[]> {
    const { rows } = await (client ?? this.pool).query(
      `SELECT table_id, seat_no, user_id, seat_session_id, stack, state
         FROM poker.seats WHERE table_id = $1 ORDER BY seat_no`,
      [tableId],
    );
    return rows.map(PokerRepository.toSeat);
  }

  async findSeatOf(tableId: string, userId: string, client?: PoolClient): Promise<PokerSeat | null> {
    const { rows } = await (client ?? this.pool).query(
      `SELECT table_id, seat_no, user_id, seat_session_id, stack, state
         FROM poker.seats WHERE table_id = $1 AND user_id = $2`,
      [tableId, userId],
    );
    return rows[0] ? PokerRepository.toSeat(rows[0]) : null;
  }

  /** Every table this player is sitting at — the multi-table cap is counted from here. */
  async seatsOf(userId: string): Promise<PokerSeat[]> {
    const { rows } = await this.pool.query(
      `SELECT table_id, seat_no, user_id, seat_session_id, stack, state
         FROM poker.seats WHERE user_id = $1`,
      [userId],
    );
    return rows.map(PokerRepository.toSeat);
  }

  async takeSeat(client: PoolClient, seat: Omit<PokerSeat, 'state'>): Promise<void> {
    await client.query(
      `INSERT INTO poker.seats (table_id, seat_no, user_id, seat_session_id, stack)
       VALUES ($1, $2, $3, $4, $5)`,
      [seat.tableId, seat.seatNo, seat.userId, seat.seatSessionId, seat.stack],
    );
  }

  async setStack(client: PoolClient, tableId: string, userId: string, stack: number): Promise<void> {
    await client.query('UPDATE poker.seats SET stack = $3 WHERE table_id = $1 AND user_id = $2', [
      tableId,
      userId,
      stack,
    ]);
  }

  async setSeatState(
    client: PoolClient,
    tableId: string,
    userId: string,
    state: PokerSeat['state'],
  ): Promise<void> {
    await client.query('UPDATE poker.seats SET state = $3 WHERE table_id = $1 AND user_id = $2', [
      tableId,
      userId,
      state,
    ]);
  }

  async removeSeat(client: PoolClient, tableId: string, userId: string): Promise<void> {
    await client.query('DELETE FROM poker.seats WHERE table_id = $1 AND user_id = $2', [
      tableId,
      userId,
    ]);
  }

  async advanceTable(
    client: PoolClient,
    tableId: string,
    input: { buttonSeat: number; handNo: number },
  ): Promise<void> {
    await client.query('UPDATE poker.tables SET button_seat = $2, hand_no = $3 WHERE id = $1', [
      tableId,
      input.buttonSeat,
      input.handNo,
    ]);
  }

  async recordHand(
    client: PoolClient,
    input: {
      matchId: string;
      tableId: string;
      handNo: number;
      buttonSeat: number;
      pot: number;
      rake: number;
      board: string[];
      summary: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO poker.hands (match_id, table_id, hand_no, button_seat, pot, rake, board, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8)
       ON CONFLICT (match_id) DO NOTHING`,
      [
        input.matchId,
        input.tableId,
        input.handNo,
        input.buttonSeat,
        input.pot,
        input.rake,
        input.board,
        JSON.stringify(input.summary),
      ],
    );
  }

  /** Recent hands at a table — the history strip, and the audit trail a dispute starts from. */
  async recentHands(tableId: string, limit = 20): Promise<
    Array<{ matchId: string; handNo: number; pot: number; rake: number; board: string[] }>
  > {
    const { rows } = await this.pool.query(
      `SELECT match_id, hand_no, pot, rake, board FROM poker.hands
        WHERE table_id = $1 ORDER BY hand_no DESC LIMIT $2`,
      [tableId, limit],
    );
    return rows.map((row) => ({
      matchId: row.match_id,
      handNo: Number(row.hand_no),
      pot: Number(row.pot),
      rake: Number(row.rake),
      board: row.board as string[],
    }));
  }

  /**
   * The hand currently being played at a table, if any.
   *
   * Read from `game.matches` rather than from a column here, so there is one answer to
   * "is a hand in progress" and it is the engine's.
   */
  async findActiveHand(tableId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT m.id FROM game.matches m
        WHERE m.game_code = 'poker'
          AND m.config->>'tableId' = $1
          AND m.status IN ('created','starting','in_progress','settling')
        ORDER BY m.created_at DESC LIMIT 1`,
      [tableId],
    );
    return rows[0]?.id ?? null;
  }

  /** Sum of seated stacks — one half of the table-escrow invariant (ADR-025). */
  async totalSeatedStacks(tableId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(stack), 0)::text AS total FROM poker.seats WHERE table_id = $1`,
      [tableId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  private static toTable(row: Record<string, unknown>): PokerTable {
    return {
      id: row.id as string,
      tierId: row.tier_id as string,
      name: row.name as string,
      seatCount: Number(row.seat_count),
      currency: row.currency as string,
      config: (row.config ?? {}) as Record<string, unknown>,
      status: row.status as PokerTable['status'],
      buttonSeat: Number(row.button_seat),
      handNo: Number(row.hand_no),
    };
  }

  private static toSeat(row: Record<string, unknown>): PokerSeat {
    return {
      tableId: row.table_id as string,
      seatNo: Number(row.seat_no),
      userId: row.user_id as string,
      seatSessionId: row.seat_session_id as string,
      stack: Number(row.stack),
      state: row.state as PokerSeat['state'],
    };
  }
}
