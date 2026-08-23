/** Queue names are declared centrally; job *classes* live in the owning domain module. */
export const QueueName = {
  /** Reconciliation, chain verification and similar periodic platform work (P4 populates it). */
  PLATFORM: 'platform',
  /** Matchmaking upkeep — the formation sweep that catches players a failed attempt left waiting. */
  MATCHMAKING: 'matchmaking',
} as const;

export type QueueNameValue = (typeof QueueName)[keyof typeof QueueName];
