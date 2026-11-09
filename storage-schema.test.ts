import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as Effect from 'effect/Effect'

import { eventJournal, eventRemotes } from '~/framework/event-journal.schema'
import { clusterMessages, clusterReplies, clusterRunners } from '~/framework/workflow-storage.schema'
import { ShoppingDb } from '~/infrastructure/database.service'
import { testRuntime } from '~/test/runtime/root.runtime'

for (const table of [clusterMessages, clusterReplies, clusterRunners, eventJournal, eventRemotes]) {
  const config = getTableConfig(table)

  test(`engine read schema matches the installed Effect version's ${config.name} table`, async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
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

        const actual = yield* db.execute<(typeof expected)[number]>(
          sql`
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
          `,
          'objects',
        )

        expect(actual).toEqual(expected)
      }),
    )
  })
}
