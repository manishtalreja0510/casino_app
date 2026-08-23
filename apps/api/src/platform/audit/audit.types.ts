export type ActorType = 'user' | 'admin' | 'system';

/**
 * One audited action. `payload` carries opaque identifiers and outcomes ONLY —
 * never names, emails, documents, tokens, or amounts attributable to a person
 * beyond what the ledger already records (rule 15).
 */
export interface AuditEntry {
  readonly actorType: ActorType;
  readonly actorId?: string | null;
  /** Dotted, stable, greppable: `wallet.reversal`, `flags.change`, `auth.login_failed`. */
  readonly action: string;
  readonly subjectRef?: string | null;
  readonly payload?: Record<string, unknown>;
}

export interface AuditChainVerification {
  /** Nothing that was checked was wrong. **Not** the same as "the chain is intact".  */
  readonly valid: boolean;
  readonly checked: number;
  /**
   * The whole chain was walked, end to end.
   *
   * Separate from `valid` deliberately. Verification reads a bounded window, so a caller
   * that only looks at `valid` can be told "fine" about a chain it never finished
   * reading — which is precisely the failure hash-chaining exists to rule out. A chain is
   * intact only when `valid && complete`.
   */
  readonly complete: boolean;
  /** `seq` of the first row whose hash does not match — the point of tampering. */
  readonly brokenAtSeq?: number;
  readonly reason?: string;
  /** Where a caller paging through the chain should continue from. */
  readonly nextFromSeq?: number;
}
