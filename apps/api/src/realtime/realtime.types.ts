/** Wire protocol for the `/game` namespace (`docs/03-api/websocket-conventions.md`). */

/** Bumped only on a breaking envelope change; payloads evolve additively (rule 23). */
export const REALTIME_PROTOCOL_VERSION = 1;

export interface RealtimeEnvelope<T = unknown> {
  /** Protocol version, so an older sideloaded client can detect it is behind. */
  v: number;
  /** Monotonic per room. The client uses it to detect gaps and to resume. */
  seq: number;
  /** Event name, `domain:action`. */
  type: string;
  /** Server time in epoch ms. Advisory for display only — the server owns all deadlines. */
  ts: number;
  room: string;
  payload: T;
}

export const ClientEvent = {
  JOIN: 'room:join',
  LEAVE: 'room:leave',
  RESUME: 'resume',
} as const;

export const ServerEvent = {
  JOINED: 'room:joined',
  LEFT: 'room:left',
  EVENT: 'room:event',
  RESUME_COMPLETE: 'resume:complete',
  RESYNC_REQUIRED: 'resync:required',
  ERROR: 'error',
} as const;

export interface JoinRequest {
  room: string;
}

export interface ResumeRequest {
  room: string;
  /** Last sequence the client applied. 0 means "I have nothing". */
  lastSeq: number;
}

export interface SocketIdentity {
  userId: string;
  sessionId: string;
  deviceId?: string;
}

/** Room naming. Membership is authorised from these shapes — never from client claims. */
export const Rooms = {
  user: (userId: string): string => `user:${userId}`,
  match: (matchId: string): string => `match:${matchId}`,
} as const;
