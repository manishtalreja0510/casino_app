import { boolean, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

export const platformSchema = pgSchema('platform');

/** Truth for feature flags and kill-switches (rule 16). Redis only caches this. */
export const featureFlags = platformSchema.table('feature_flags', {
  key: text('key').primaryKey(),
  valueBool: boolean('value_bool').notNull(),
  description: text('description').notNull().default(''),
  requiresFourEyes: boolean('requires_four_eyes').notNull().default(false),
  updatedBy: text('updated_by').notNull().default('system'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type FeatureFlagRow = typeof featureFlags.$inferSelect;
