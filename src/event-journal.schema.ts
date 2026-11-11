import { bigint, customType, integer, pgTable, text } from 'drizzle-orm/pg-core'

// PostgreSQL read mappings for Effect 4.1.2. SqlEventJournal owns creation and migration.
const bytea = /* @__PURE__ */ customType<{ data: Uint8Array }>({ dataType: () => 'bytea' })

export const eventJournal = /* @__PURE__ */ (() => pgTable('effect_event_journal', {
  id: bytea('id').primaryKey(),
  event: text('event').notNull(),
  primaryKey: text('primary_key').notNull(),
  payload: bytea('payload').notNull(),
  timestamp: bigint('timestamp', { mode: 'bigint' }).notNull(),
}))()

export const eventJournalSequence = /* @__PURE__ */ (() => pgTable('effect_event_journal_sequence', {
  sequence: bigint('sequence', { mode: 'bigint' }).primaryKey(),
  entryId: bytea('entry_id').notNull().unique(),
}))()

export const eventJournalSources = /* @__PURE__ */ (() => pgTable('effect_event_journal_sources', {
  entryId: bytea('entry_id').primaryKey(),
  remoteId: bytea('remote_id').notNull(),
}))()

export const eventRemoteCheckpoints = /* @__PURE__ */ (() => pgTable('effect_event_remotes_checkpoints', {
  remoteId: bytea('remote_id').primaryKey(),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
}))()

export const eventRemoteCursors = /* @__PURE__ */ (() => pgTable('effect_event_remotes_cursors', {
  remoteId: bytea('remote_id').primaryKey(),
  nextSequence: integer('next_sequence').notNull(),
}))()
