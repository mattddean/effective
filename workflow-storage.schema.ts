import { bigint, boolean, integer, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'

// Read mappings only; Effect owns table creation and migrations. Schema tests check the installed version's DDL.
export const clusterMessages = pgTable('cluster_messages', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  rowId: bigint('rowid', { mode: 'bigint' }).notNull(),
  messageId: varchar('message_id', { length: 255 }),
  shardId: varchar('shard_id', { length: 50 }).notNull(),
  entityType: varchar('entity_type', { length: 150 }).notNull(),
  entityId: varchar('entity_id', { length: 255 }).notNull(),
  kind: integer('kind').notNull(),
  tag: varchar('tag', { length: 50 }),
  payload: text('payload'),
  headers: text('headers'),
  traceId: varchar('trace_id', { length: 32 }),
  spanId: varchar('span_id', { length: 16 }),
  sampled: boolean('sampled'),
  processed: boolean('processed').notNull(),
  requestId: bigint('request_id', { mode: 'bigint' }).notNull(),
  replyId: bigint('reply_id', { mode: 'bigint' }),
  lastReplyId: bigint('last_reply_id', { mode: 'bigint' }),
  lastRead: timestamp('last_read'),
  deliverAt: bigint('deliver_at', { mode: 'bigint' }),
})

export const clusterReplies = pgTable('cluster_replies', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  rowId: bigint('rowid', { mode: 'bigint' }).notNull(),
  kind: integer('kind'),
  requestId: bigint('request_id', { mode: 'bigint' }).notNull(),
  payload: text('payload').notNull(),
  sequence: integer('sequence'),
  acked: boolean('acked').notNull(),
})

export const clusterRunners = pgTable('cluster_runners', {
  machineId: integer('machine_id').primaryKey(),
  address: varchar('address', { length: 255 }).notNull(),
  runner: text('runner').notNull(),
  healthy: boolean('healthy').notNull(),
  lastHeartbeat: timestamp('last_heartbeat').notNull(),
})
