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
  readonly valid: boolean;
  readonly checked: number;
  /** `seq` of the first row whose hash does not match — the point of tampering. */
  readonly brokenAtSeq?: number;
  readonly reason?: string;
}
