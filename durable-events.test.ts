import { PgClient } from '@effect/sql-pg'
import { beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, like, sql } from 'drizzle-orm'
import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
import * as Cause from 'effect/Cause'
import { EntityAddress, EntityId, EntityType, MessageStorage, ShardId, Sharding } from 'effect/cluster'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import { SchemaBinary } from 'effect/encoding'
import { EventJournal } from 'effect/eventlog'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import { Activity, DurableClock, Workflow, WorkflowEngine } from 'effect/workflow'

import { defineEvent, defineListener } from '~/framework/event.logic'
import { defineModule } from '~/framework/module.logic'
import { listenerFixture, type ListenerFixtureDefinition } from '~/framework/test/listener-fixture.layer'
import { WorkerCrashWorkflow } from '~/framework/test/worker-crash.workflow-contract'
import { WorkerCrashFact } from '~/framework/worker-crash.event'
import { clusterMessages } from '~/framework/workflow-storage.schema'
import { ShoppingDb } from '~/infrastructure/database.service'
import { ShoppingTransaction, withShoppingTransaction } from '~/infrastructure/transaction.operation'
import { TestPgClientLive } from '~/test/pg-client.layer'
import { testRuntime } from '~/test/runtime/root.runtime'
import { workflowTestNodeLayer } from '~/workflows/workflow-test.layer'

// A neutral domain fixture keeps the engine's guarantees independent of the application's family/post schema.
const mutation = pgTable('effective_test_mutations', {
  id: uuid('id').primaryKey(),
  value: text('value').notNull(),
})
const Payload = Schema.Struct({ id: Schema.String, value: Schema.Literal('created') })
const payloadCodec = SchemaBinary.toCodec(Payload)
const Fact = defineEvent('effective.test-fact', { payload: Payload })
const AtomicDelivery = Workflow.make('effective-test-atomic-delivery', {
  payload: { id: Schema.String },
  idempotencyKey: (input) => input.id,
})
type FactPayload = Schema.Schema.Type<typeof Payload>
type FixtureId = typeof mutation.$inferSelect.id

beforeAll(async () => {
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* PgClient.PgClient
      yield* client`CREATE TABLE effective_test_mutations (id UUID PRIMARY KEY, value TEXT NOT NULL)`
    }),
  )
})

const records = Effect.fn('EventTest.records')(function* (id: FixtureId) {
  const journal = yield* EventJournal.EventJournal
  const entries = yield* journal.entries
  const decoded = yield* Effect.forEach(
    entries.filter((entry) => entry.event === Fact.name),
    (entry) =>
      Schema.decodeEffect(payloadCodec)(new Uint8Array(entry.payload)).pipe(
        Effect.map((payload) => ({ entry, payload })),
      ),
  )
  return decoded.filter((record) => record.payload.id === id)
})

const starts = Effect.fn('EventTest.starts')(function* (id: FixtureId) {
  const db = yield* ShoppingDb
  return yield* db
    .select()
    .from(clusterMessages)
    .where(and(eq(clusterMessages.tag, 'run'), like(clusterMessages.payload, `%${id}%`)))
})

const completedStarts = Effect.fn('EventTest.completedStarts')((id: FixtureId) =>
  starts(id).pipe(
    Effect.repeat({
      while: (jobs) => jobs.length === 0 || jobs.some((job) => !job.processed),
      schedule: Schedule.spaced('10 millis'),
    }),
    Effect.timeout('3 seconds'),
  ),
)

const publishMutation = Effect.fn('EventTest.publishMutation')(function* (id: FixtureId) {
  const db = yield* ShoppingDb
  yield* db.insert(mutation).values({ id, value: 'created' })
  yield* Fact.publish({ id, value: 'created' })
})

function listener<E>(
  options: ListenerFixtureDefinition<FactPayload, E, never, never> & { readonly name: `effective.${string}` },
): Layer.Layer<never, never, typeof Fact.name | ShoppingDb | WorkflowEngine.WorkflowEngine> {
  return listenerFixture(Fact, options)
}

const fixtureContext = Effect.fn('EventTest.fixtureContext')(function* (
  listeners: readonly Layer.Layer<never, never, typeof Fact.name | ShoppingDb | WorkflowEngine.WorkflowEngine>[],
) {
  const workerContext = yield* Layer.build(workflowTestNodeLayer({ group: 'local', worker: true }))
  const module = defineModule({ imports: [], internal: [], exports: [], listeners })
  const context = yield* Layer.build(
    module.pipe(Layer.provideMerge(Layer.fresh(Fact.layer)), Layer.provide(Layer.succeedContext(workerContext))),
  )
  const sharding = Context.get(workerContext, Sharding.Sharding)
  // Startup resets workflow rows; let it acquire the shard before tests hold DDL locks on those tables.
  yield* Effect.sync(() => sharding.hasShardId(ShardId.make('local', 1))).pipe(
    Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced('10 millis') }),
    Effect.timeout('3 seconds'),
  )
  return { context, workerContext }
})

describe('Effect storage compatibility: journal writes and persisted workflow starts share the publisher transaction', () => {
  test.each(['commit', 'rollback', 'commit-failure'] as const)(
    'an active worker cannot run before the event and workflow start commit: %s',
    async (outcome) => {
      await testRuntime.runPromise(
        Effect.gen(function* () {
          const db = yield* ShoppingDb
          const journal = yield* EventJournal.EventJournal
          const id = crypto.randomUUID()
          const payload = yield* Schema.encodeEffect(payloadCodec)({ id, value: 'created' })
          const staged = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const completed = yield* Deferred.make<void>()
          let calls = 0
          const { workerContext } = yield* fixtureContext([])
          const worker = Context.get(workerContext, WorkflowEngine.WorkflowEngine)
          yield* worker
            .register(
              AtomicDelivery,
              Effect.fn('EventTest.nativeDelivery')(function* () {
                calls++
                yield* Deferred.succeed(completed, undefined)
              }),
            )
            .pipe(Effect.provide(workerContext))

          const publication = yield* withShoppingTransaction(
            Effect.gen(function* () {
              const tx = yield* ShoppingDb
              if (outcome === 'commit-failure') {
                yield* tx.execute(sql`
                ALTER TABLE ${mutation} ADD CONSTRAINT reject_native_event_commit
                FOREIGN KEY (id) REFERENCES effect_event_journal(id)
                DEFERRABLE INITIALLY DEFERRED NOT VALID
              `)
              }
              yield* tx.insert(mutation).values({ id, value: 'created' })
              // The native callback runs before INSERT; delivery is scheduled only after write has returned.
              yield* journal.write({ event: Fact.name, primaryKey: id, payload, effect: () => Effect.void })
              yield* AtomicDelivery.execute({ id }, { discard: true }).pipe(Effect.provide(workerContext))
              expect(yield* records(id)).toHaveLength(1)
              expect(yield* starts(id)).toHaveLength(1)
              yield* Deferred.succeed(staged, undefined)
              yield* Deferred.await(release)
              if (outcome === 'rollback') return yield* Effect.fail('publisher rolled back' as const)
            }),
          ).pipe(Effect.exit, Effect.forkChild)
          yield* Effect.raceFirst(
            Deferred.await(staged),
            Fiber.join(publication).pipe(
              Effect.flatMap((result) =>
                Exit.isFailure(result)
                  ? Effect.failCause(result.cause)
                  : Effect.die('native publication ended before staging'),
              ),
            ),
          )
          expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(0)
          expect(yield* records(id)).toHaveLength(0)
          expect(yield* starts(id)).toHaveLength(0)
          yield* Effect.sleep('50 millis')
          expect(calls).toBe(0)
          yield* Deferred.succeed(release, undefined)
          const result = yield* Fiber.join(publication)
          expect(Exit.isSuccess(result)).toBe(outcome === 'commit')
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain(
              outcome === 'rollback' ? 'publisher rolled back' : 'reject_native_event_commit',
            )
          if (outcome === 'commit') {
            yield* Deferred.await(completed)
            yield* completedStarts(id)
            expect(calls).toBe(1)
          } else {
            yield* Effect.sleep('50 millis')
            expect(calls).toBe(0)
          }
          expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(
            outcome === 'commit' ? 1 : 0,
          )
          expect(yield* records(id)).toHaveLength(outcome === 'commit' ? 1 : 0)
          expect(yield* starts(id)).toHaveLength(outcome === 'commit' ? 1 : 0)
        }).pipe(Effect.scoped, Effect.timeout('5 seconds')),
      )
    },
    10000,
  )
})

describe('Effective product requirement: every committed domain fact has a native durable journal record', () => {
  test.each(['none', 'transactional'] as const)('records the typed fact with %s listeners', async (kind) => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const id = crypto.randomUUID()
        let calls = 0
        const listeners =
          kind === 'none'
            ? []
            : [
                listener({
                  name: 'effective.inline-only',
                  processing: 'transactional',
                  make: Effect.succeed(
                    Effect.fn('EventTest.inlineOnly')(() =>
                      Effect.sync(() => {
                        calls++
                      }),
                    ),
                  ),
                }),
              ]
        const { context } = yield* fixtureContext(listeners)
        yield* withShoppingTransaction(publishMutation(id)).pipe(Effect.provide(context))
        const saved = yield* records(id)
        expect(saved).toHaveLength(1)
        expect(saved[0]?.payload).toEqual({ id, value: 'created' })
        expect(saved[0]?.entry.createdAtMillis).toBeGreaterThan(0)
        expect(calls).toBe(kind === 'none' ? 0 : 1)
        expect(yield* starts(id)).toHaveLength(0)
      }).pipe(Effect.scoped),
    )
  })

  test('identical payloads published twice represent two distinct facts, independent of listeners', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const id = crypto.randomUUID()
        const { context } = yield* fixtureContext([])
        yield* withShoppingTransaction(Fact.publish({ id, value: 'created' })).pipe(Effect.provide(context))
        yield* withShoppingTransaction(Fact.publish({ id, value: 'created' })).pipe(Effect.provide(context))
        const saved = yield* records(id)
        expect(saved).toHaveLength(2)
        expect(new Set(saved.map(({ entry }) => entry.idString)).size).toBe(2)
      }).pipe(Effect.scoped),
    )
  })
})

describe('Effective product requirement: transactional listeners share the publisher transaction and determine its success', () => {
  test('awaits the listener and keeps its writes and the fact invisible until commit', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
        const journal = yield* EventJournal.EventJournal
        const id = crypto.randomUUID()
        const written = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()
        const { context } = yield* fixtureContext([
          listener({
            name: 'effective.inline-write',
            processing: 'transactional',
            make: Effect.succeed(
              Effect.fn('EventTest.inlineWrite')(function* (payload: FactPayload) {
                const tx = yield* ShoppingDb
                expect(tx).toBe(yield* ShoppingTransaction)
                expect(
                  yield* records(payload.id).pipe(Effect.provideService(EventJournal.EventJournal, journal)),
                ).toHaveLength(1)
                yield* tx.update(mutation).set({ value: 'handled' }).where(eq(mutation.id, payload.id))
                yield* Deferred.succeed(written, undefined)
                yield* Deferred.await(release)
              }),
            ),
          }),
        ])
        const publication = yield* withShoppingTransaction(publishMutation(id)).pipe(
          Effect.provide(context),
          Effect.tap(() => Deferred.succeed(finished, undefined)),
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.forkChild,
        )
        yield* Effect.raceFirst(
          Deferred.await(written),
          Fiber.join(publication).pipe(Effect.andThen(Effect.die('publication ended before its listener wrote'))),
        )
        expect(yield* Deferred.isDone(finished)).toBe(false)
        expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(0)
        expect(yield* records(id)).toHaveLength(0)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(publication)
        expect((yield* db.select().from(mutation).where(eq(mutation.id, id)))[0]?.value).toBe('handled')
        expect(yield* records(id)).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })

  test('listener failure rolls back the mutation, listener writes, journal entry, and async work intents', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
        const journal = yield* EventJournal.EventJournal
        const id = crypto.randomUUID()
        let workflowCalls = 0
        const { context } = yield* fixtureContext([
          listener({
            name: 'effective.async-rollback',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.asyncRollback')(() =>
                Effect.sync(() => {
                  workflowCalls++
                }),
              ),
            ),
          }),
          listener({
            name: 'effective.inline-failure',
            processing: 'transactional',
            make: Effect.succeed(
              Effect.fn('EventTest.inlineFailure')(function* (payload: FactPayload) {
                const tx = yield* ShoppingDb
                expect(
                  yield* records(payload.id).pipe(Effect.provideService(EventJournal.EventJournal, journal)),
                ).toHaveLength(1)
                yield* tx.update(mutation).set({ value: 'failed' }).where(eq(mutation.id, payload.id))
                return yield* Effect.fail('listener failed' as const)
              }),
            ),
          }),
        ])
        const result = yield* withShoppingTransaction(publishMutation(id)).pipe(Effect.provide(context), Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('listener failed')
        expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(0)
        expect(yield* records(id)).toHaveLength(0)
        expect(yield* starts(id)).toHaveLength(0)
        yield* Effect.sleep('50 millis')
        expect(workflowCalls).toBe(0)
      }).pipe(Effect.scoped),
    )
  })
})

describe('Effective product requirement: each listener selects its mode and both modes coexist on one event', () => {
  test('inserts the event, finishes every transactional listener, persists async starts, then commits', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
        const journal = yield* EventJournal.EventJournal
        const id = crypto.randomUUID()
        const firstFinished = yield* Deferred.make<void>()
        const lastStarted = yield* Deferred.make<Context.Context<ShoppingDb | ShoppingTransaction>>()
        const lastFinished = yield* Deferred.make<void>()
        const releaseInline = yield* Deferred.make<void>()
        const staged = yield* Deferred.make<Context.Context<ShoppingDb | ShoppingTransaction>>()
        const releaseCommit = yield* Deferred.make<void>()
        const handled = yield* Deferred.make<void>()
        let workflowCalls = 0
        const { context } = yield* fixtureContext([
          // Registration order must not move async scheduling ahead of transactional listeners.
          listener({
            name: 'effective.order-async',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.orderAsync')(function* () {
                workflowCalls++
                yield* Deferred.succeed(handled, undefined)
              }),
            ),
          }),
          listener({
            name: 'effective.order-first',
            processing: 'transactional',
            make: Effect.succeed(
              Effect.fn('EventTest.orderFirst')(function* (payload: FactPayload) {
                const tx = yield* ShoppingDb
                expect(tx).toBe(yield* ShoppingTransaction)
                expect(
                  yield* records(payload.id).pipe(Effect.provideService(EventJournal.EventJournal, journal)),
                ).toHaveLength(1)
                expect(yield* starts(payload.id)).toHaveLength(0)
                yield* tx.update(mutation).set({ value: 'first-finished' }).where(eq(mutation.id, payload.id))
                yield* Deferred.succeed(firstFinished, undefined)
              }),
            ),
          }),
          listener({
            name: 'effective.order-last',
            processing: 'transactional',
            make: Effect.succeed(
              Effect.fn('EventTest.orderLast')(function* (payload: FactPayload) {
                yield* Deferred.await(firstFinished)
                const tx = yield* ShoppingDb
                expect(tx).toBe(yield* ShoppingTransaction)
                expect(
                  yield* records(payload.id).pipe(Effect.provideService(EventJournal.EventJournal, journal)),
                ).toHaveLength(1)
                expect(yield* starts(payload.id)).toHaveLength(0)
                yield* Deferred.succeed(lastStarted, yield* Effect.context<ShoppingDb | ShoppingTransaction>())
                yield* Deferred.await(releaseInline)
                expect(yield* starts(payload.id)).toHaveLength(0)
                yield* tx.update(mutation).set({ value: 'all-inline-finished' }).where(eq(mutation.id, payload.id))
                yield* Deferred.succeed(lastFinished, undefined)
              }),
            ),
          }),
        ])
        const publication = yield* withShoppingTransaction(
          Effect.gen(function* () {
            yield* publishMutation(id)
            expect(yield* Deferred.isDone(firstFinished)).toBe(true)
            expect(yield* Deferred.isDone(lastFinished)).toBe(true)
            expect(yield* records(id)).toHaveLength(1)
            expect(yield* starts(id)).toHaveLength(1)
            yield* Deferred.succeed(staged, yield* Effect.context<ShoppingDb | ShoppingTransaction>())
            yield* Deferred.await(releaseCommit)
          }),
        ).pipe(Effect.provide(context), Effect.exit, Effect.forkChild)
        const awaitPhase = Effect.fn('EventTest.awaitOrderPhase')(
          (phase: Deferred.Deferred<Context.Context<ShoppingDb | ShoppingTransaction>>) =>
            Effect.raceFirst(
              Deferred.await(phase),
              Fiber.join(publication).pipe(
                Effect.flatMap((result) =>
                  Exit.isFailure(result)
                    ? Effect.failCause(result.cause)
                    : Effect.die('publication ended before its expected phase'),
                ),
              ),
            ),
        )

        const inlineContext = yield* awaitPhase(lastStarted)
        expect(yield* Deferred.isDone(firstFinished)).toBe(true)
        expect(yield* Deferred.isDone(lastFinished)).toBe(false)
        expect(yield* records(id).pipe(Effect.provide(inlineContext))).toHaveLength(1)
        expect(yield* starts(id).pipe(Effect.provide(inlineContext))).toHaveLength(0)
        expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(0)
        expect(yield* records(id)).toHaveLength(0)
        expect(workflowCalls).toBe(0)

        yield* Deferred.succeed(releaseInline, undefined)
        const publisherContext = yield* awaitPhase(staged)
        const tx = Context.get(publisherContext, ShoppingDb)
        expect(
          (yield* tx.select().from(mutation).where(eq(mutation.id, id)).pipe(Effect.provide(publisherContext)))[0]
            ?.value,
        ).toBe('all-inline-finished')
        expect(yield* records(id).pipe(Effect.provide(publisherContext))).toHaveLength(1)
        expect(yield* starts(id).pipe(Effect.provide(publisherContext))).toHaveLength(1)
        expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(0)
        expect(yield* records(id)).toHaveLength(0)
        expect(yield* starts(id)).toHaveLength(0)
        yield* Effect.sleep('50 millis')
        expect(workflowCalls).toBe(0)

        yield* Deferred.succeed(releaseCommit, undefined)
        expect(Exit.isSuccess(yield* Fiber.join(publication))).toBe(true)
        expect((yield* db.select().from(mutation).where(eq(mutation.id, id)))[0]?.value).toBe('all-inline-finished')
        expect(yield* records(id)).toHaveLength(1)
        expect(yield* starts(id)).toHaveLength(1)
        yield* Deferred.await(handled)
        expect(workflowCalls).toBe(1)
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })

  test('commits inline effects without waiting for the async listener to finish', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
        const id = crypto.randomUUID()
        const release = yield* Deferred.make<void>()
        const handled = yield* Deferred.make<void>()
        const { context } = yield* fixtureContext([
          listener({
            name: 'effective.mixed-inline',
            processing: 'transactional',
            make: Effect.succeed(
              Effect.fn('EventTest.mixedInline')(function* (payload: FactPayload) {
                const tx = yield* ShoppingDb
                yield* tx.update(mutation).set({ value: 'inline' }).where(eq(mutation.id, payload.id))
              }),
            ),
          }),
          listener({
            name: 'effective.mixed-async',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.mixedAsync')(function* (payload: FactPayload) {
                yield* Deferred.await(release)
                const workerDb = yield* ShoppingDb
                yield* workerDb.update(mutation).set({ value: 'async' }).where(eq(mutation.id, payload.id))
                yield* Deferred.succeed(handled, undefined)
              }),
            ),
          }),
        ])
        const result = yield* withShoppingTransaction(publishMutation(id)).pipe(
          Effect.provide(context),
          Effect.timeoutOption('250 millis'),
        )
        expect(Option.isSome(result)).toBe(true)
        expect(yield* Deferred.isDone(handled)).toBe(false)
        expect((yield* db.select().from(mutation).where(eq(mutation.id, id)))[0]?.value).toBe('inline')
        expect(yield* records(id)).toHaveLength(1)
        expect(yield* starts(id)).toHaveLength(1)
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(handled)
        yield* completedStarts(id)
        expect((yield* db.select().from(mutation).where(eq(mutation.id, id)))[0]?.value).toBe('async')
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })

  test('async failure leaves the mutation and fact committed and does not prevent another listener succeeding', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
        const id = crypto.randomUUID()
        const succeeded = yield* Deferred.make<void>()
        const failed = yield* Deferred.make<void>()
        const { context } = yield* fixtureContext([
          listener({
            name: 'effective.async-success',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.asyncSuccess')(() => Deferred.succeed(succeeded, undefined).pipe(Effect.asVoid)),
            ),
          }),
          listener({
            name: 'effective.async-failure',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.asyncFailure')(function* () {
                yield* Deferred.succeed(failed, undefined)
                return yield* Effect.fail('async failed' as const)
              }),
            ),
          }),
        ])
        const result = yield* withShoppingTransaction(publishMutation(id)).pipe(Effect.provide(context), Effect.exit)
        expect(Exit.isSuccess(result)).toBe(true)
        yield* Deferred.await(succeeded)
        yield* Deferred.await(failed)
        expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(1)
        expect(yield* records(id)).toHaveLength(1)
        expect(yield* starts(id)).toHaveLength(2)
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })

  test('async listeners use native activities and durable waits without holding the publisher transaction', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
        const id = crypto.randomUUID()
        const handled = yield* Deferred.make<void>()
        let writes = 0
        const { context } = yield* fixtureContext([
          listener({
            name: 'effective.native-workflow',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.nativeWorkflow')(function* (payload: FactPayload) {
                expect(Option.isNone(Context.getOption(yield* Effect.context<never>(), ShoppingTransaction))).toBe(true)
                yield* Activity.make({
                  name: 'write-listener-result',
                  execute: withShoppingTransaction(
                    Effect.gen(function* () {
                      writes++
                      const tx = yield* ShoppingDb
                      yield* tx.update(mutation).set({ value: 'activity' }).where(eq(mutation.id, payload.id))
                    }),
                  ).pipe(Effect.orDie),
                })
                yield* DurableClock.sleep({
                  name: 'listener-delay',
                  duration: '20 millis',
                  inMemoryThreshold: '1 millis',
                })
                yield* Deferred.succeed(handled, undefined)
              }),
            ),
          }),
        ])
        yield* withShoppingTransaction(publishMutation(id)).pipe(Effect.provide(context))
        yield* Deferred.await(handled)
        yield* completedStarts(id)
        expect(writes).toBe(1)
        expect((yield* db.select().from(mutation).where(eq(mutation.id, id)))[0]?.value).toBe('activity')
        expect(yield* records(id)).toHaveLength(1)
        expect(yield* starts(id)).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })

  test('async workflows release database transactions before waiting for third-party responses', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
        const client = yield* PgClient.PgClient
        const id = crypto.randomUUID()
        const requestStarted = yield* Deferred.make<ReadonlyArray<{ pid: typeof process.pid }>>()
        const responseReceived = yield* Deferred.make<void>()
        // An independent pool observes the worker connection without borrowing it for the inspection query.
        const observerContext = yield* Layer.build(Layer.fresh(TestPgClientLive))
        const observer = Context.get(observerContext, PgClient.PgClient)
        const { context } = yield* fixtureContext([
          listener({
            name: 'effective.third-party-call',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.thirdPartyCall')(function* (payload: FactPayload) {
                const workerContext = yield* Effect.context<never>()
                expect(Option.isNone(Context.getOption(workerContext, ShoppingTransaction))).toBe(true)
                expect(Option.isNone(Context.getOption(workerContext, client.transactionService))).toBe(true)
                const connections = yield* withShoppingTransaction(
                  client<{ pid: typeof process.pid }>`
                    UPDATE effective_test_mutations SET value = 'before-third-party-call'
                    WHERE id = ${payload.id} RETURNING pg_backend_pid() AS pid
                  `,
                ).pipe(Effect.orDie)
                yield* Deferred.succeed(requestStarted, connections)
                yield* Deferred.await(responseReceived)
              }),
            ),
          }),
        ])
        yield* withShoppingTransaction(publishMutation(id)).pipe(Effect.provide(context))
        const connections = yield* Deferred.await(requestStarted)
        expect(connections).toHaveLength(1)
        expect((yield* db.select().from(mutation).where(eq(mutation.id, id)))[0]?.value).toBe('before-third-party-call')
        const jobs = yield* starts(id)
        expect(jobs).toHaveLength(1)
        expect(jobs[0]?.processed).toBe(false)
        for (const { pid } of connections) {
          // Ignore transient polling statements; inspect the connection once it is idle at the external-call gate.
          const sessions = yield* observer<{ transaction_open: boolean; busy: boolean }>`
            SELECT xact_start IS NOT NULL AS transaction_open, state = 'active' AS busy
            FROM pg_stat_activity WHERE pid = ${pid}
          `.pipe(
            Effect.provide(observerContext),
            Effect.repeat({
              while: (rows) => rows.some((row) => row.busy),
              schedule: Schedule.spaced('10 millis'),
            }),
            Effect.timeout('250 millis'),
          )
          expect(sessions).toEqual([{ transaction_open: false, busy: false }])
        }
        expect(yield* Deferred.isDone(responseReceived)).toBe(false)
        yield* Deferred.succeed(responseReceived, undefined)
        yield* completedStarts(id)
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })
})

describe('Effective product requirement: event history and async scheduling are atomic with the domain mutation', () => {
  test('a rejected event insert invokes neither transactional nor workflow listeners, even in memory', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
        const id = crypto.randomUUID()
        let inlineCalls = 0
        let workflowCalls = 0
        const { context } = yield* fixtureContext([
          listener({
            name: 'effective.rejected-inline',
            processing: 'transactional',
            make: Effect.succeed(
              Effect.fn('EventTest.rejectedInline')(() =>
                Effect.sync(() => {
                  inlineCalls++
                }),
              ),
            ),
          }),
          listener({
            name: 'effective.rejected-workflow',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.rejectedWorkflow')(() =>
                Effect.sync(() => {
                  workflowCalls++
                }),
              ),
            ),
          }),
        ])
        const result = yield* withShoppingTransaction(
          Effect.gen(function* () {
            const tx = yield* ShoppingDb
            yield* tx.execute(sql`
            ALTER TABLE effect_event_journal ADD CONSTRAINT reject_effective_dispatch
            CHECK (event <> 'effective.test-fact') NOT VALID
          `)
            yield* publishMutation(id)
            // Roll back the temporary constraint even if publication incorrectly succeeds.
            return yield* Effect.fail('event insert was not attempted' as const)
          }),
        ).pipe(Effect.provide(context), Effect.exit)
        yield* Effect.sleep('50 millis')
        // Memory counters survive rollback and expose handler execution that row assertions cannot detect.
        expect({ inlineCalls, workflowCalls }).toEqual({ inlineCalls: 0, workflowCalls: 0 })
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('reject_effective_dispatch')
        expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(0)
        expect(yield* records(id)).toHaveLength(0)
        expect(yield* starts(id)).toHaveLength(0)
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })

  test('a database COMMIT failure rolls back the event, inline writes, and workflow intent without executing async work', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
        const id = crypto.randomUUID()
        let inlineCalls = 0
        let workflowCalls = 0
        const { context } = yield* fixtureContext([
          listener({
            name: 'effective.commit-inline',
            processing: 'transactional',
            make: Effect.succeed(
              Effect.fn('EventTest.commitInline')(function* (payload: FactPayload) {
                inlineCalls++
                const tx = yield* ShoppingDb
                yield* tx.update(mutation).set({ value: 'inline' }).where(eq(mutation.id, payload.id))
              }),
            ),
          }),
          listener({
            name: 'effective.commit-workflow',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.commitWorkflow')(() =>
                Effect.sync(() => {
                  workflowCalls++
                }),
              ),
            ),
          }),
        ])
        const result = yield* withShoppingTransaction(
          Effect.gen(function* () {
            const tx = yield* ShoppingDb
            // The UUID v4 domain id cannot match the journal's generated UUID v7 id; rejection is deferred until COMMIT.
            yield* tx.execute(sql`
            ALTER TABLE ${mutation} ADD CONSTRAINT reject_effective_commit
            FOREIGN KEY (id) REFERENCES effect_event_journal(id)
            DEFERRABLE INITIALLY DEFERRED NOT VALID
          `)
            yield* publishMutation(id)
            expect((yield* tx.select().from(mutation).where(eq(mutation.id, id)))[0]?.value).toBe('inline')
            expect(yield* records(id)).toHaveLength(1)
            expect(yield* starts(id)).toHaveLength(1)
          }),
        ).pipe(Effect.provide(context), Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain('reject_effective_commit')
        yield* Effect.sleep('50 millis')
        expect({ inlineCalls, workflowCalls }).toEqual({ inlineCalls: 1, workflowCalls: 0 })
        expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(0)
        expect(yield* records(id)).toHaveLength(0)
        expect(yield* starts(id)).toHaveLength(0)
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })

  test.each(['journal', 'workflow'] as const)(
    '%s storage failure rejects publication and rolls back every write',
    async (storage) => {
      await testRuntime.runPromise(
        Effect.gen(function* () {
          const db = yield* ShoppingDb
          const id = crypto.randomUUID()
          const { context } = yield* fixtureContext([
            listener({
              name: 'effective.storage-failure',
              processing: 'workflow',
              make: Effect.succeed(Effect.fn('EventTest.storageFailure')(() => Effect.void)),
            }),
          ])
          const result = yield* withShoppingTransaction(
            Effect.gen(function* () {
              const tx = yield* ShoppingDb
              // Transaction-local constraints exercise real storage rejection without changing subsequent tests.
              yield* tx.execute(
                storage === 'journal'
                  ? sql`
              ALTER TABLE effect_event_journal ADD CONSTRAINT reject_effective_event
              CHECK (event <> 'effective.test-fact') NOT VALID
            `
                  : sql`
              ALTER TABLE ${clusterMessages} ADD CONSTRAINT reject_effective_workflow
              CHECK (tag <> 'run') NOT VALID
            `,
              )
              yield* publishMutation(id)
              // Keep the constraint local even while this intentionally red specification catches missing persistence.
              return yield* Effect.fail('storage accepted publication' as const)
            }),
          ).pipe(Effect.provide(context), Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain(
              storage === 'journal' ? 'reject_effective_event' : 'reject_effective_workflow',
            )
          expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(0)
          expect(yield* records(id)).toHaveLength(0)
          expect(yield* starts(id)).toHaveLength(0)
        }).pipe(Effect.scoped),
      )
    },
  )

  test.each(['commit', 'rollback'] as const)(
    'workers cannot observe an uncommitted event; the publisher chooses %s',
    async (outcome) => {
      await testRuntime.runPromise(
        Effect.gen(function* () {
          const db = yield* ShoppingDb
          const journal = yield* EventJournal.EventJournal
          const id = crypto.randomUUID()
          const staged = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const handled = yield* Deferred.make<void>()
          const { context } = yield* fixtureContext([
            listener({
              name: 'effective.after-commit',
              processing: 'workflow',
              make: Effect.succeed(
                Effect.fn('EventTest.afterCommit')(function* (payload: FactPayload) {
                  const workerDb = yield* ShoppingDb
                  expect(yield* workerDb.select().from(mutation).where(eq(mutation.id, payload.id))).toHaveLength(1)
                  expect(
                    yield* records(payload.id).pipe(Effect.provideService(EventJournal.EventJournal, journal)),
                  ).toHaveLength(1)
                  yield* Deferred.succeed(handled, undefined)
                }),
              ),
            }),
          ])
          const publication = yield* withShoppingTransaction(
            Effect.gen(function* () {
              yield* publishMutation(id)
              expect(yield* records(id)).toHaveLength(1)
              expect(yield* starts(id)).toHaveLength(1)
              yield* Deferred.succeed(staged, undefined)
              yield* Deferred.await(release)
              if (outcome === 'rollback') return yield* Effect.fail('rollback' as const)
            }),
          ).pipe(Effect.provide(context), Effect.exit, Effect.forkChild)
          yield* Effect.raceFirst(
            Deferred.await(staged),
            Fiber.join(publication).pipe(
              Effect.flatMap((result) =>
                Exit.isFailure(result)
                  ? Effect.failCause(result.cause)
                  : Effect.die('publication ended before staging'),
              ),
            ),
          )
          expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(0)
          expect(yield* records(id)).toHaveLength(0)
          expect(yield* starts(id)).toHaveLength(0)
          yield* Effect.sleep('50 millis')
          expect(yield* Deferred.isDone(handled)).toBe(false)
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.join(publication))).toBe(outcome === 'commit')
          expect(yield* records(id)).toHaveLength(outcome === 'commit' ? 1 : 0)
          if (outcome === 'commit') yield* Deferred.await(handled)
          else {
            expect(yield* db.select().from(mutation).where(eq(mutation.id, id))).toHaveLength(0)
            expect(yield* starts(id)).toHaveLength(0)
            expect(yield* Deferred.isDone(handled)).toBe(false)
          }
        }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
      )
    },
  )
})

describe('Effective product requirement: workflow consumers stay independent for every journal entry', () => {
  test('equal workflow keys cannot suppress separate event deliveries or their history', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const id = crypto.randomUUID()
        const anotherId = crypto.randomUUID()
        let transactionalCalls = 0
        let firstCalls = 0
        let secondCalls = 0
        const { context } = yield* fixtureContext([
          listener({
            name: 'effective.every-publication',
            processing: 'transactional',
            make: Effect.succeed(
              Effect.fn('EventTest.everyPublication')(() =>
                Effect.sync(() => {
                  transactionalCalls++
                }),
              ),
            ),
          }),
          listener({
            name: 'effective.first-keyed-consumer',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.firstKeyedConsumer')(() =>
                Effect.sync(() => {
                  firstCalls++
                }),
              ),
            ),
          }),
          listener({
            name: 'effective.second-keyed-consumer',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.secondKeyedConsumer')(() =>
                Effect.sync(() => {
                  secondCalls++
                }),
              ),
            ),
          }),
        ])
        yield* withShoppingTransaction(publishMutation(id)).pipe(Effect.provide(context))
        const original = yield* completedStarts(id)
        expect(original).toHaveLength(2)
        expect(new Set(original.map((job) => job.entityId)).size).toBe(2)
        expect(firstCalls).toBe(1)
        expect(secondCalls).toBe(1)

        yield* withShoppingTransaction(Fact.publish({ id, value: 'created' })).pipe(Effect.provide(context))
        const repeated = yield* completedStarts(id)
        expect(repeated).toHaveLength(4)
        expect(new Set(repeated.map((job) => job.entityId)).size).toBe(4)
        expect(firstCalls).toBe(2)
        expect(secondCalls).toBe(2)
        expect(yield* records(id)).toHaveLength(2)

        yield* withShoppingTransaction(publishMutation(anotherId)).pipe(Effect.provide(context))
        expect(yield* completedStarts(anotherId)).toHaveLength(2)
        expect(firstCalls).toBe(3)
        expect(secondCalls).toBe(3)
        expect(transactionalCalls).toBe(3)
        expect(yield* records(anotherId)).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })
})

describe('Effective product requirement: async delivery survives restarts and event history outlives workflow storage', () => {
  test('a SIGKILLed worker resumes an unfinished listener without repeating its completed durable activity', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const db = yield* ShoppingDb
        const journal = yield* EventJournal.EventJournal
        const id = crypto.randomUUID()
        const startWorker = Effect.fn('EventTest.startCrashWorker')((mode: 'crash' | 'recover') =>
          Effect.acquireRelease(
            Effect.sync(() =>
              Bun.spawn([process.execPath, `${import.meta.dir}/worker-crash.runtime.ts`, mode], {
                env: process.env,
                stdout: 'ignore',
                stderr: 'inherit',
              }),
            ),
            (worker) =>
              Effect.sync(() => worker.kill('SIGKILL')).pipe(Effect.andThen(Effect.promise(() => worker.exited))),
          ),
        )
        const subscription = defineListener(WorkerCrashFact, {
          name: 'effective.crash-recovery',
          processing: 'workflow',
          workflow: WorkerCrashWorkflow,
          mapPayload: (payload) => payload,
        })
        const client = yield* Layer.build(workflowTestNodeLayer({ group: 'local', worker: false }))
        const context = yield* Layer.build(
          subscription.pipe(
            Layer.provideMerge(Layer.fresh(WorkerCrashFact.layer)),
            Layer.provide(Layer.succeedContext(client)),
          ),
        )
        yield* withShoppingTransaction(
          Effect.gen(function* () {
            const tx = yield* ShoppingDb
            yield* tx.insert(mutation).values({ id, value: 'created' })
            yield* WorkerCrashFact.publish({ id })
          }),
        ).pipe(Effect.provide(context))
        const entries = (yield* journal.entries).filter((entry) => entry.event === WorkerCrashFact.name)
        expect(entries).toHaveLength(1)
        const pending = yield* starts(id)
        expect(pending).toHaveLength(1)
        expect(pending[0]?.processed).toBe(false)

        const worker = yield* startWorker('crash')
        const paused = yield* db
          .select()
          .from(mutation)
          .where(eq(mutation.id, id))
          .pipe(
            Effect.repeat({
              while: (rows) => rows[0]?.value !== 'created:activity:waiting',
              schedule: Schedule.spaced('10 millis'),
            }),
          )
        expect(paused[0]?.value).toBe('created:activity:waiting')
        expect((yield* starts(id))[0]?.processed).toBe(false)
        worker.kill('SIGKILL')
        yield* Effect.promise(() => worker.exited)
        expect(worker.signalCode).toBe('SIGKILL')
        expect((yield* starts(id))[0]?.processed).toBe(false)
        expect((yield* journal.entries).filter((entry) => entry.event === WorkerCrashFact.name)).toEqual(entries)

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startWorker('recover')
            const completed = yield* completedStarts(id)
            expect(completed.map((job) => job.id)).toEqual(pending.map((job) => job.id))
            expect((yield* db.select().from(mutation).where(eq(mutation.id, id)))[0]?.value).toBe(
              'created:activity:waiting:waiting:finished',
            )
          }),
        )
      }).pipe(Effect.scoped, Effect.timeout('10 seconds')),
    )
  }, 15000)

  test('records pending delivery without a worker and processes it after a fresh engine starts', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const id = crypto.randomUUID()
        let calls = 0
        const completed = yield* Deferred.make<void>()
        const subscription = listener({
          name: 'effective.recovery',
          processing: 'workflow',
          make: Effect.succeed(
            Effect.fn('EventTest.recovery')(() =>
              Effect.sync(() => {
                calls++
              }).pipe(Effect.andThen(Deferred.succeed(completed, undefined)), Effect.asVoid),
            ),
          ),
        })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* Layer.build(workflowTestNodeLayer({ group: 'local', worker: false }))
            const context = yield* Layer.build(
              defineModule({ imports: [], internal: [], exports: [], listeners: [subscription] }).pipe(
                Layer.provideMerge(Layer.fresh(Fact.layer)),
                Layer.provide(Layer.succeedContext(client)),
              ),
            )
            yield* withShoppingTransaction(publishMutation(id)).pipe(Effect.provide(context))
            expect(calls).toBe(0)
            expect(yield* records(id)).toHaveLength(1)
            expect(yield* starts(id)).toHaveLength(1)
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* fixtureContext([Layer.fresh(subscription)])
            yield* Deferred.await(completed)
            yield* completedStarts(id)
            expect(calls).toBe(1)
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* fixtureContext([Layer.fresh(subscription)])
            const saved = yield* records(id)
            expect(saved).toHaveLength(1)
            yield* completedStarts(id)
            yield* Effect.sleep('50 millis')
            expect(calls).toBe(1)
          }),
        )
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })

  test('clearing completed workflow messages retains the original journal entry and typed payload', async () => {
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const id = crypto.randomUUID()
        const completed = yield* Deferred.make<void>()
        const { context } = yield* fixtureContext([
          listener({
            name: 'effective.retention',
            processing: 'workflow',
            make: Effect.succeed(
              Effect.fn('EventTest.retention')(() => Deferred.succeed(completed, undefined).pipe(Effect.asVoid)),
            ),
          }),
        ])
        yield* withShoppingTransaction(publishMutation(id)).pipe(Effect.provide(context))
        yield* Deferred.await(completed)
        const saved = yield* records(id)
        expect(saved).toHaveLength(1)
        const jobs = yield* completedStarts(id)
        expect(jobs).toHaveLength(1)
        const storage = yield* MessageStorage.MessageStorage
        yield* Effect.forEach(jobs, (job) =>
          storage.clearAddress(
            EntityAddress.make({
              entityType: EntityType.make(job.entityType),
              entityId: EntityId.make(job.entityId),
              shardId: ShardId.fromString(job.shardId),
            }),
          ),
        )
        expect(yield* starts(id)).toHaveLength(0)
        expect((yield* records(id)).map(({ entry, payload }) => ({ id: entry.idString, payload }))).toEqual(
          saved.map(({ entry, payload }) => ({ id: entry.idString, payload })),
        )
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
  })
})
