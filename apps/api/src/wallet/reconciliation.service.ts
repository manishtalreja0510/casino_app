import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../platform/database/database.module';

export interface ReconciliationFinding {
  check: 'transaction_balance' | 'balance_cache' | 'escrow_settled' | 'currency_consistency';
  subject: string;
  detail: string;
}

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

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

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
