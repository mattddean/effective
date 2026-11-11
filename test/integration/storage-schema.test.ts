import { expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as Effect from 'effect/Effect'

import {
  clusterMessages, clusterReplies, clusterRunners,
  eventJournal, eventJournalSequence, eventJournalSources, eventRemoteCheckpoints, eventRemoteCursors,
} from '../../src/storage/drizzle.js'
import { Database } from './fixtures/database.js'
import { testRuntime } from './fixtures/runtime.js'

for (const table of [
  clusterMessages, clusterReplies, clusterRunners,
  eventJournal, eventJournalSequence, eventJournalSources, eventRemoteCheckpoints, eventRemoteCursors,
]) {
  const config = getTableConfig(table)

  test(`engine read schema matches the installed Effect version's ${config.name} table`, async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* Database
        const expected = config.columns
          .map((column) => ({
            name: column.name,
            sqlType: column.getSQLType(),
            notNull: column.notNull,
            primaryKey:
              column.primary ||
              config.primaryKeys.some((key) => key.columns.some((keyColumn) => keyColumn.name === column.name)),
          }))
          .sort((left, right) => left.name.localeCompare(right.name))

        const actual = yield* db<(typeof expected)[number]>`
            SELECT
              a.attname AS name,
              replace(replace(format_type(a.atttypid, a.atttypmod),
                'character varying', 'varchar'), 'timestamp without time zone', 'timestamp') AS "sqlType",
              a.attnotnull AS "notNull",
              EXISTS (
                SELECT 1 FROM pg_constraint c
                WHERE c.conrelid = a.attrelid AND c.contype = 'p' AND a.attnum = ANY(c.conkey)
              ) AS "primaryKey"
            FROM pg_attribute a
            WHERE a.attrelid = ${`${config.schema ?? 'public'}.${config.name}`}::regclass
              AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attname
          `

        expect(actual).toEqual(expected)
      }),
    )
  })
}
