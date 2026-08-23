import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../platform/database/database.module';

export interface ReconciliationFinding {
  check:
    | 'transaction_balance'
    | 'balance_cache'
    | 'escrow_settled'
    | 'currency_consistency'
    | 'table_escrow';
  subject: string;
  detail: string;
}

/**
 * What a module says its escrow *should* hold.
 *
 * A table escrow is the one balance whose correct value lives outside the wallet: it is
 * the money on the felt, and only the game knows how much that is. Rather than have
 * reconciliation read `poker.seats` — which would put a wallet service inside another
 * module's tables (rule 20) and would need editing for every game that banks at a table —
 * the game declares the figure and the wallet compares it against the ledger.
 */
export interface EscrowExpectation {
  /** The `table_id` on the escrow account. */
  tableId: string;
  /** What the game says is on the table, in minor units. */
  expected: number;
  /** Optional context for the finding, e.g. how it was derived. */
  detail?: string;
}

export type EscrowExpectationSource = () => Promise<EscrowExpectation[]>;

export interface ReconciliationReport {
  ok: boolean;
  checked: { transactions: number; accounts: number };
  findings: ReconciliationFinding[];
}

/**
 * Detects ledger drift (rule 9).
 *
 * **It never repairs anything.** Auto-correction would paper over the bug that caused the
 * drift and destroy the evidence needed to find it. A finding is a page for a human, and
 * the correct response is to freeze the affected scope, investigate via the event log and
 * audit trail, and correct — if at all — by posting a reversal.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  private readonly escrowSources: EscrowExpectationSource[] = [];

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Registers a game's view of what its table escrows hold.
   *
   * Called at bootstrap by any game that banks at a table (ADR-025). A game that never
   * registers is not silently assumed correct — it simply has no table escrows to check,
   * because only a table-banked game creates one.
   */
  registerEscrowSource(source: EscrowExpectationSource): void {
    this.escrowSources.push(source);
  }

  async run(): Promise<ReconciliationReport> {
    const findings: ReconciliationFinding[] = [];

    // 1. Every transaction's entries sum to zero. The deferred trigger enforces this at
    //    write time; checking again here catches anything that bypassed it.
    const unbalanced = await this.pool.query<{ tx_id: string; total: string }>(
      `SELECT tx_id, SUM(amount)::text AS total
         FROM wallet.ledger_entries
        GROUP BY tx_id
       HAVING SUM(amount) <> 0`,
    );
    for (const row of unbalanced.rows) {
      findings.push({
        check: 'transaction_balance',
        subject: row.tx_id,
        detail: `entries sum to ${row.total}, expected 0`,
      });
    }

    // 2. Cached balances match the ledger's own sum. The cache is an optimisation; the
    //    entries are the truth (ADR-008).
    const drift = await this.pool.query<{ account_id: string; cached: string; derived: string }>(
      `SELECT b.account_id,
              b.amount::text AS cached,
              COALESCE(e.total, 0)::text AS derived
         FROM wallet.balances b
         LEFT JOIN (
           SELECT account_id, SUM(amount) AS total FROM wallet.ledger_entries GROUP BY account_id
         ) e ON e.account_id = b.account_id
        WHERE b.amount <> COALESCE(e.total, 0)`,
    );
    for (const row of drift.rows) {
      findings.push({
        check: 'balance_cache',
        subject: row.account_id,
        detail: `cached ${row.cached} but ledger says ${row.derived}`,
      });
    }

    // 3. A settled match's escrow must be empty. Money stuck in escrow means a settlement
    //    that paid out less than it took in — the failure mode that silently eats players' stakes.
    const escrow = await this.pool.query<{ account_id: string; match_id: string; amount: string }>(
      `SELECT b.account_id, a.match_id, b.amount::text AS amount
         FROM wallet.balances b
         JOIN wallet.accounts a ON a.id = b.account_id
        WHERE a.type = 'match_escrow'
          AND b.amount <> 0
          AND EXISTS (
            SELECT 1 FROM wallet.ledger_transactions t
             WHERE t.ref_type = 'match' AND t.ref_id = a.match_id::text AND t.type = 'settlement'
          )`,
    );
    for (const row of escrow.rows) {
      findings.push({
        check: 'escrow_settled',
        subject: row.match_id,
        detail: `escrow still holds ${row.amount} after settlement`,
      });
    }

    // 4. No transaction mixes currencies.
    const mixed = await this.pool.query<{ tx_id: string; currencies: string }>(
      `SELECT tx_id, string_agg(DISTINCT currency, ',') AS currencies
         FROM wallet.ledger_entries
        GROUP BY tx_id
       HAVING COUNT(DISTINCT currency) > 1`,
    );
    for (const row of mixed.rows) {
      findings.push({
        check: 'currency_consistency',
        subject: row.tx_id,
        detail: `transaction spans currencies: ${row.currencies}`,
      });
    }

    // 5. A table escrow holds exactly what is on the felt (ADR-025).
    //
    //    The one invariant P9 left asserted only in its tests, which is not the same thing
    //    as watched: a test proves the code was right about the hands it played, and this
    //    proves it is still right about the money sitting on real tables right now. Drift
    //    here means chips exist that no stack accounts for, or a stack that no money backs
    //    — the two shapes of "somebody's buy-in has quietly gone missing".
    for (const source of this.escrowSources) {
      let expectations: EscrowExpectation[];
      try {
        expectations = await source();
      } catch (error) {
        // A source that cannot answer is itself a finding: an unchecked invariant must
        // never look the same as a satisfied one.
        findings.push({
          check: 'table_escrow',
          subject: 'expectation_source',
          detail: `could not be read: ${error instanceof Error ? error.message : 'unknown'}`,
        });
        continue;
      }

      for (const expectation of expectations) {
        const held = await this.pool.query<{ amount: string }>(
          `SELECT COALESCE(b.amount, 0)::text AS amount
             FROM wallet.accounts a
             LEFT JOIN wallet.balances b ON b.account_id = a.id
            WHERE a.type = 'table_escrow' AND a.table_id = $1`,
          [expectation.tableId],
        );
        const escrowAmount = Number(held.rows[0]?.amount ?? 0);

        if (escrowAmount !== expectation.expected) {
          findings.push({
            check: 'table_escrow',
            subject: expectation.tableId,
            detail:
              `escrow holds ${escrowAmount} but the table says ${expectation.expected}` +
              (expectation.detail ? ` (${expectation.detail})` : ''),
          });
        }
      }
    }

    const counts = await this.pool.query<{ transactions: string; accounts: string }>(
      `SELECT (SELECT count(*) FROM wallet.ledger_transactions)::text AS transactions,
              (SELECT count(*) FROM wallet.balances)::text AS accounts`,
    );

    const report: ReconciliationReport = {
      ok: findings.length === 0,
      checked: {
        transactions: Number(counts.rows[0]?.transactions ?? 0),
        accounts: Number(counts.rows[0]?.accounts ?? 0),
      },
      findings,
    };

    if (!report.ok) {
      // This is a page, not a log line: money is wrong somewhere.
      this.logger.error(
        `LEDGER DRIFT DETECTED — ${findings.length} finding(s): ` +
          findings.map((f) => `${f.check}/${f.subject}`).join(', '),
      );
    }
    return report;
  }
}
