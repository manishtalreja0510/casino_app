-- 0003_wallet — P4 wallet & double-entry ledger (ADR-008).
-- See docs/02-domains/wallet.md and docs/01-architecture/database-architecture.md §3.
-- ROLLBACK: DROP SCHEMA IF EXISTS wallet CASCADE;   (only while no production data exists)

CREATE SCHEMA IF NOT EXISTS wallet;

-- ---------------------------------------------------------------------------
-- accounts — one row per (owner, currency). House accounts have no user.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet.accounts (
  id          uuid PRIMARY KEY,
  type        text NOT NULL CHECK (type IN
              ('user_wallet', 'house_main', 'house_dev_funding', 'rake', 'bonus', 'match_escrow')),
  user_id     uuid NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  match_id    uuid NULL,
  currency    char(3) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One wallet per user per currency; one escrow per match per currency.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_currency_uq
  ON wallet.accounts (user_id, currency) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_match_currency_uq
  ON wallet.accounts (match_id, currency) WHERE match_id IS NOT NULL;
-- House accounts are singletons per type+currency.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_house_uq
  ON wallet.accounts (type, currency) WHERE user_id IS NULL AND match_id IS NULL;

-- ---------------------------------------------------------------------------
-- ledger_transactions — the unit of atomic money movement.
-- `idempotency_key` is UNIQUE: replaying an operation cannot post it twice (rule 6).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet.ledger_transactions (
  id              uuid PRIMARY KEY,
  type            text NOT NULL,                -- funding | buy_in | settlement | reversal | adjustment
  idempotency_key text NOT NULL,
  ref_type        text NULL,                    -- e.g. 'match'
  ref_id          text NULL,
  reverses_tx_id  uuid NULL REFERENCES wallet.ledger_transactions (id),
  created_by      text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_transactions_idem_uq
  ON wallet.ledger_transactions (idempotency_key);
CREATE INDEX IF NOT EXISTS ledger_transactions_ref_idx
  ON wallet.ledger_transactions (ref_type, ref_id);

-- ---------------------------------------------------------------------------
-- ledger_entries — signed amounts in integer minor units (rule 4).
-- Entries of one transaction MUST sum to zero (rule 5), enforced below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet.ledger_entries (
  id          uuid PRIMARY KEY,
  tx_id       uuid   NOT NULL REFERENCES wallet.ledger_transactions (id),
  account_id  uuid   NOT NULL REFERENCES wallet.accounts (id),
  amount      bigint NOT NULL CHECK (amount <> 0),   -- negative = debit, positive = credit
  currency    char(3) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON wallet.ledger_entries (account_id, created_at);
CREATE INDEX IF NOT EXISTS ledger_entries_tx_idx ON wallet.ledger_entries (tx_id);

-- ---------------------------------------------------------------------------
-- balances — a CACHE of the derived sum, not the truth (ADR-008).
-- Updated in the same transaction as its entries, so it can never lag them.
-- The CHECK is the last line of defence against an overdraw slipping past
-- application logic: the database refuses to hold a negative player balance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallet.balances (
  account_id  uuid PRIMARY KEY REFERENCES wallet.accounts (id),
  amount      bigint NOT NULL DEFAULT 0,
  currency    char(3) NOT NULL,
  version     bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Player wallets may never go negative. House accounts may (they are the counterparty
-- that funds the system), so the constraint is scoped by account type.
CREATE OR REPLACE FUNCTION wallet.assert_non_negative_user_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  account_type text;
BEGIN
  SELECT type INTO account_type FROM wallet.accounts WHERE id = NEW.account_id;
  IF account_type = 'user_wallet' AND NEW.amount < 0 THEN
    RAISE EXCEPTION 'insufficient funds: user balance would become %', NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS balances_non_negative ON wallet.balances;
CREATE TRIGGER balances_non_negative
  BEFORE INSERT OR UPDATE ON wallet.balances
  FOR EACH ROW EXECUTE FUNCTION wallet.assert_non_negative_user_balance();

-- ---------------------------------------------------------------------------
-- Append-only: corrections are reversal transactions, never edits (rule 5).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wallet.reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet ledger is append-only: % on % is not permitted (rule 5)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_no_mutation ON wallet.ledger_entries;
CREATE TRIGGER ledger_entries_no_mutation
  BEFORE UPDATE OR DELETE ON wallet.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wallet.reject_ledger_mutation();

DROP TRIGGER IF EXISTS ledger_transactions_no_mutation ON wallet.ledger_transactions;
CREATE TRIGGER ledger_transactions_no_mutation
  BEFORE UPDATE OR DELETE ON wallet.ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION wallet.reject_ledger_mutation();

-- ---------------------------------------------------------------------------
-- Zero-sum: the defining property of double entry.
--
-- Enforced by a CONSTRAINT TRIGGER deferred to commit, because entries are inserted one
-- row at a time and the balance only holds once all of them are in. Deferring means the
-- check runs when the transaction tries to commit — so an unbalanced transaction cannot
-- be committed by any code path, including a future one that forgets to check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wallet.assert_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  imbalance bigint;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO imbalance
    FROM wallet.ledger_entries WHERE tx_id = NEW.tx_id;

  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance: entries sum to %', NEW.tx_id, imbalance
      USING ERRCODE = 'check_violation';
  END IF;

  -- A single-entry "transfer" is balanced only if it is zero, which the amount CHECK
  -- already forbids — but a transaction with one entry is still nonsense, so reject it.
  IF (SELECT count(*) FROM wallet.ledger_entries WHERE tx_id = NEW.tx_id) < 2 THEN
    RAISE EXCEPTION 'ledger transaction % must have at least two entries', NEW.tx_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_balanced ON wallet.ledger_entries;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON wallet.ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION wallet.assert_transaction_balanced();

REVOKE UPDATE, DELETE, TRUNCATE ON wallet.ledger_entries FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON wallet.ledger_transactions FROM PUBLIC;
