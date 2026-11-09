import { expect, test } from 'bun:test'
import { SqliteClient } from '@effect/sql-sqlite-bun'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { EventJournal } from 'effect/eventlog'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'

import { createEventSystem, EventJournalLive, EventListenerError } from '../../src/index.js'

class Database extends Context.Service<Database, SqlClient.SqlClient>()('EventsTest/Database') {}
class Transaction extends Context.Service<Transaction, Database['Service']>()('EventsTest/Transaction') {}
const { defineEvent, defineListener } = createEventSystem({ database: Database, transaction: Transaction })
const event = defineEvent('example.created', { payload: Schema.Struct({ id: Schema.String }), concurrency: 1 })
const sqlite = SqliteClient.layer({ filename: ':memory:' })
const runtime = EventJournalLive.pipe(Layer.provideMerge(sqlite))
const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(effect.pipe(Effect.provideService(Transaction, sql)))
  })

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type PublicationRequiresTransaction = Assert<
  Equal<Effect.Services<ReturnType<typeof event.publish>>, typeof event.name | Transaction>
>
const goodListener = defineListener(event, {
  name: 'example.listener', processing: 'transactional',
  make: Effect.succeed(() => Database.pipe(Effect.asVoid)),
})
export type ListenerCapturesNoDatabase = Assert<Equal<Layer.Services<typeof goodListener>, typeof event.name>>

for (const failure of ['none', 'listener', 'publisher'] as const) {
  test(`SQL publication, journal, and listener writes are atomic: ${failure}`, async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const journal = yield* EventJournal.EventJournal
      yield* sql`CREATE TABLE domain (id TEXT PRIMARY KEY)`
      yield* sql`CREATE TABLE projection (id TEXT PRIMARY KEY)`
      const listener = defineListener(event, {
        name: 'example.projection', processing: 'transactional',
        make: Effect.succeed((payload) => Effect.gen(function* () {
          const db = yield* Database
          expect(db).toBe(sql)
          expect((yield* journal.entries).length).toBe(1)
          yield* db`INSERT INTO projection (id) VALUES (${payload.id})`
          if (failure === 'listener') return yield* Effect.fail('listener-failed' as const)
        })),
      })
      yield* Layer.build(listener)
      const result = yield* withTransaction(Effect.gen(function* () {
        yield* sql`INSERT INTO domain (id) VALUES ('first')`
        yield* event.publish({ id: 'first' })
        if (failure === 'publisher') return yield* Effect.fail('publisher-failed' as const)
      })).pipe(Effect.result)
      expect(result._tag).toBe(failure === 'none' ? 'Success' : 'Failure')
      const expected = failure === 'none' ? 1 : 0
      expect((yield* sql`SELECT * FROM domain`).length).toBe(expected)
      expect((yield* sql`SELECT * FROM projection`).length).toBe(expected)
      expect((yield* journal.entries).length).toBe(expected)
    }).pipe(
      Effect.provide(event.layer),
      Effect.scoped,
      Effect.provide(runtime),
    ))
  })
}

test('publication without listeners is journaled; scoped subscriptions are removed', async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const journal = yield* EventJournal.EventJournal
    const seen: string[] = []
    const listener = defineListener(event, {
      name: 'example.scoped', processing: 'transactional',
      make: Effect.succeed((payload) => Effect.sync(() => { seen.push(payload.id) })),
    })
    yield* Effect.scoped(Effect.gen(function* () {
      yield* Layer.build(listener)
      yield* withTransaction(event.publish({ id: 'during' }))
    }))
    yield* withTransaction(event.publish({ id: 'after' }))
    expect(seen).toEqual(['during'])
    expect((yield* journal.entries).length).toBe(2)
  }).pipe(Effect.provide(event.layer), Effect.provide(runtime)))
})

test('typed listener failures retain the event, listener, and cause', async () => {
  const listener = defineListener(event, {
    name: 'example.failing', processing: 'transactional',
    make: Effect.succeed(() => Effect.fail('failure' as const)),
  })
  const error = await Effect.runPromise(Effect.gen(function* () {
    yield* Layer.build(listener)
    return yield* withTransaction(event.publish({ id: 'failed' })).pipe(Effect.flip)
  }).pipe(Effect.provide(event.layer), Effect.scoped, Effect.provide(runtime)))
  expect(error).toBeInstanceOf(EventListenerError)
  expect(error).toMatchObject({ event: 'example.created', listener: 'example.failing', cause: 'failure' })
})

// Exercise the persistence boundary without claiming to test a running cluster worker.
for (const failScheduling of [false, true]) {
  test(`workflow starts use the publication transaction and distinct delivery IDs: failure=${failScheduling}`, async () => {
    const { Workflow, WorkflowEngine } = await import('effect/workflow')
    const workflow = Workflow.make('example.workflow', {
      payload: { id: Schema.String },
      error: Schema.String,
      idempotencyKey: () => 'constant-business-key',
    })
    const engineLayer = Layer.effect(WorkflowEngine.WorkflowEngine, Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine
      const sql = yield* SqlClient.SqlClient
      let calls = 0
      const execute = ((_workflow, options) => Effect.gen(function* () {
        expect(Boolean(options.discard)).toBe(true)
        expect((yield* sql`SELECT * FROM effect_event_journal`).length).toBeGreaterThan(0)
        yield* sql`INSERT INTO starts (id) VALUES (${options.executionId})`
        if (failScheduling && ++calls === 2) return yield* Effect.fail('storage-failed')
        return options.executionId
      })) as typeof engine.execute
      return { ...engine, execute }
    }))
    const listeners = ['first', 'second'].map(name => defineListener(event, {
      name: `example.${name}`,
      processing: 'workflow', workflow,
      mapPayload: payload => payload,
    }))
    await Effect.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const journal = yield* EventJournal.EventJournal
      yield* sql`CREATE TABLE starts (id TEXT PRIMARY KEY)`
      yield* Layer.build(Layer.mergeAll(listeners[0]!, listeners[1]!))
      const result = yield* withTransaction(Effect.gen(function* () {
        yield* event.publish({ id: 'same-payload' })
        yield* event.publish({ id: 'same-payload' })
      })).pipe(Effect.result)
      expect(result._tag).toBe(failScheduling ? 'Failure' : 'Success')
      const rows = yield* sql<{ id: string }>`SELECT id FROM starts`
      expect(rows.length).toBe(failScheduling ? 0 : 4)
      expect(new Set(rows.map(row => row.id)).size).toBe(rows.length)
      for (const row of rows) expect(row.id).toMatch(/^[a-f0-9]{64}$/)
      expect((yield* journal.entries).length).toBe(failScheduling ? 0 : 2)
    }).pipe(
      Effect.provide(event.layer),
      Effect.provide(engineLayer),
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.scoped,
      Effect.provide(runtime),
    ))
  })
}
