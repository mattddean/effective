import { expect, test } from 'bun:test'
import { SqliteClient } from '@effect/sql-sqlite-bun'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as Effect from 'effect/Effect'
import { SqlClient } from 'effect/sql'
import { EventJournalLive } from '../../src/index.js'
import * as Layer from 'effect/Layer'
import {
  eventJournal, eventJournalSequence, eventJournalSources, eventRemoteCheckpoints, eventRemoteCursors,
} from '../../src/storage.js'

test('journal read models match columns and type families created by the installed Effect version', async () => {
  const client = SqliteClient.layer({ filename: ':memory:' })
  const runtime = EventJournalLive.pipe(Layer.provideMerge(client))
  const family = (type: string) => /int|serial/i.test(type) ? 'integer' : /blob|bytea/i.test(type) ? 'binary' : type.toLowerCase()
  await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const table of [eventJournal, eventJournalSequence, eventJournalSources, eventRemoteCheckpoints, eventRemoteCursors]) {
      const config = getTableConfig(table)
      const actual = yield* sql.unsafe<{ name: string; type: string }>(`PRAGMA table_info("${config.name}")`)
      expect(Object.fromEntries(actual.map(column => [column.name, family(column.type)]))).toEqual(
        Object.fromEntries(config.columns.map(column => [column.name, family(column.getSQLType())])),
      )
    }
  }).pipe(Effect.provide(runtime)))
})
