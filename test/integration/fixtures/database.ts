import { PgClient } from '@effect/sql-pg'
import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ShardingConfig, SqlMessageStorage, SqlRunnerStorage } from 'effect/cluster'
import { SqlClient } from 'effect/sql'

export class Database extends Context.Service<Database, SqlClient.SqlClient>()('Integration/Database') {}
export class Transaction extends Context.Service<Transaction, Database['Service']>()('Integration/Transaction') {}

export const TestPgClientLive = PgClient.layerConfig({ url: Config.Redacted('TEST_DATABASE_URL') })
export const TestDatabaseLive = Layer.effect(Database, SqlClient.SqlClient).pipe(Layer.provideMerge(TestPgClientLive))
export const WorkflowSqlTestStorageLive = Layer.merge(SqlMessageStorage.layer, SqlRunnerStorage.layer).pipe(
  Layer.provide(ShardingConfig.layer({ availableShardGroups: ['default', 'local'] })),
  Layer.provideMerge(TestPgClientLive),
)

export const withTransaction = Effect.fn('Integration.transaction')(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const db = yield* Database
  return yield* db.withTransaction(effect.pipe(
    Effect.provideService(Database, db),
    Effect.provideService(Transaction, db),
  ))
})
