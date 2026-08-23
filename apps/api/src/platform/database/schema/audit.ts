import { bigint, customType, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const auditSchema = pgSchema('audit');

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Append-only, hash-chained audit log (rule 15).
 * There is deliberately no update or delete path — the database rejects both.
 */
export const auditLog = auditSchema.table('audit_log', {
  id: uuid('id').primaryKey(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  actorType: text('actor_type').notNull(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  subjectRef: text('subject_ref'),
  payload: jsonb('payload').notNull(),
  prevHash: bytea('prev_hash').notNull(),
  hash: bytea('hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AuditLogRow = typeof auditLog.$inferSelect;
