import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll } from 'bun:test'

// Never inherit deployment credentials. Every test run owns its PostgreSQL database.
const container = await new PostgreSqlContainer('postgres:17.9-alpine').withDatabase('effective_test').start()
process.env.TEST_DATABASE_URL = container.getConnectionUri()
afterAll(async () => {
  const { testRuntime } = await import('./fixtures/runtime.js')
  await testRuntime.dispose()
  await container.stop()
}, 60000)
const { testRuntime } = await import('./fixtures/runtime.js')
const { Database } = await import('./fixtures/database.js')
const Effect = await import('effect/Effect')
await testRuntime.runPromise(Database.use(db => Effect.gen(function* () {
  yield* db`CREATE TABLE test_users (id TEXT PRIMARY KEY)`
  yield* db`CREATE TABLE test_missing_ids (id UUID PRIMARY KEY)`
})))
