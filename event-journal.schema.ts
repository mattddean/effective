import { bigint, customType, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'

// Read mappings only; SqlEventJournal owns these tables, including its replication metadata.
const bytea = customType<{ data: Uint8Array }>({ dataType: () => 'bytea' })

export const eventJournal = pgTable('effect_event_journal', {
  id: uuid('id').primaryKey(),
  event: text('event').notNull(),
  primaryKey: text('primary_key').notNull(),
  payload: bytea('payload').notNull(),
  timestamp: bigint('timestamp', { mode: 'bigint' }).notNull(),
})

export const eventRemotes = pgTable(
  'effect_event_remotes',
  {
    remoteId: uuid('remote_id').notNull(),
    entryId: uuid('entry_id').notNull(),
    sequence: integer('sequence').notNull(),
  },
  (table) => [primaryKey({ columns: [table.remoteId, table.entryId] })],
)
