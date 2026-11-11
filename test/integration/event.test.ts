import type { WorkflowEngine } from 'effect/workflow'

import { expect, test } from 'bun:test'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Workflow } from 'effect/workflow'

import { defineEvent, defineListener } from './fixtures/events.js'
import { defineModule, defineModules } from '../../src/module.logic.js'
import { Database, Transaction, withTransaction } from './fixtures/database.js'
import { testRuntime } from './fixtures/runtime.js'

const TypedEvent = defineEvent('test.typed', { payload: Schema.Struct({ value: Schema.Boolean }) })

test('module-owned events and consumer imports share one channel without exposing it publicly', async () => {
  const event = defineEvent('test.module-owned', { payload: Schema.Struct({ value: Schema.Boolean }) })
  class Publisher extends Context.Service<
    Publisher,
    {
      readonly publish: (payload: {
        readonly value: boolean
      }) => Effect.Effect<void, Effect.Error<ReturnType<typeof event.publish>>, Transaction>
    }
  >()('EventTest/Publisher') {}
  const publisher = defineModule({
    imports: [],
    internal: [],
    events: [event],
    exports: [
      Layer.effect(
        Publisher,
        Effect.map(event.key, (channel) => ({ publish: channel.publish })),
      ),
    ],
  })
  const received: boolean[] = []
  const consumer = defineModule({
    imports: [event.layer],
    internal: [],
    exports: [],
    listeners: [
      defineListener(event, {
        name: 'test.module-consumer',
        processing: 'transactional',
        make: Effect.succeed(
          Effect.fn('Test.moduleConsumer')((payload) =>
            Effect.sync(() => {
              received.push(payload.value)
            }),
          ),
        ),
      }),
    ],
  })
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(defineModules([publisher, consumer]))
      expect(Option.isNone(Context.getOption(context, event.key))).toBe(true)
      yield* withTransaction(Context.get(context, Publisher).publish({ value: true }))
      expect(received).toEqual([true])
    }).pipe(Effect.scoped),
  )
})
const TypedTransactionalListener = defineListener(TypedEvent, {
  name: 'test.typed-transactional',
  processing: 'transactional',
  make: Effect.succeed(Effect.fn('Test.typedTransactional')(() => Effect.void)),
})
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<Condition extends true> = Condition
export type PublicationRequiresTransaction = Assert<
  Equal<Effect.Services<ReturnType<typeof TypedEvent.publish>>, typeof TypedEvent.name | Transaction>
>
export type PublicationPayload = Assert<Equal<Parameters<typeof TypedEvent.publish>[0], { readonly value: boolean }>>
export type TransactionalListenerNeedsNoWorker = Assert<
  Equal<Layer.Services<typeof TypedTransactionalListener>, typeof TypedEvent.name>
>
const TypedWorkflow = Workflow.make('typed-workflow-listener', {
  payload: { value: Schema.Boolean },
  idempotencyKey: () => 'typed',
})
const TypedWorkflowListener = defineListener(TypedEvent, {
  name: 'test.typed-workflow',
  processing: 'workflow',
  workflow: TypedWorkflow,
  mapPayload: (payload) => payload,
})
export type WorkflowListenerNeedsOnlyEventAndEngine = Assert<
  Equal<Layer.Services<typeof TypedWorkflowListener>, typeof TypedEvent.name | WorkflowEngine.WorkflowEngine>
>

test.each([
  { label: 'unbounded by default', concurrency: undefined, peak: 4 },
  { label: 'explicitly unbounded', concurrency: 'unbounded' as const, peak: 4 },
  { label: 'bounded', concurrency: 2, peak: 2 },
  { label: 'sequential', concurrency: 1, peak: 1 },
])('event-defined concurrency is $label and publication awaits listeners', async ({ concurrency, peak }) => {
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const event = defineEvent('test.concurrent', { payload: Schema.Struct({}), concurrency })
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      let active = 0
      let observedPeak = 0
      let calls = 0
      const names = ['test.first', 'test.second', 'test.third', 'test.fourth'] as const
      const listeners = names.map((name) =>
        defineListener(event, {
          name,
          processing: 'transactional',
          make: Effect.succeed(
            Effect.fn(name)(function* () {
              active++
              calls++
              observedPeak = Math.max(observedPeak, active)
              if (active === peak) yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              active--
            }),
          ),
        }),
      )
      const module = defineModule({ imports: [], internal: [], exports: [], listeners })
      const context = yield* Layer.build(module.pipe(Layer.provideMerge(event.layer)))
      const publication = yield* withTransaction(event.publish({})).pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.provide(context),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      expect(yield* Deferred.isDone(completed)).toBe(false)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(publication)).toBeUndefined()
      expect(observedPeak).toBe(peak)
      expect(calls).toBe(4)
      expect(active).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout('5 seconds')),
  )
})

class ListenerDependency extends Context.Service<ListenerDependency, { readonly record: () => void }>()(
  'EventTest/ListenerDependency',
) {}

test('module listeners share private dependencies, register once, and unregister on disposal', async () => {
  let calls = 0
  const event = defineEvent('test.lifecycle', { payload: Schema.Struct({}) })
  const listener = defineListener(event, {
    name: 'test.record',
    processing: 'transactional',
    make: Effect.gen(function* () {
      const dependency = yield* ListenerDependency
      return Effect.fn('Test.record')(() => Effect.sync(dependency.record))
    }),
  })
  const dependency = Layer.succeed(ListenerDependency, {
    record: () => {
      calls++
    },
  })
  const module = defineModule({
    imports: [],
    internal: [dependency],
    exports: [],
    listeners: [listener],
  })
  const parent = defineModule({ imports: [module], internal: [dependency], exports: [], listeners: [listener] })
  await testRuntime.runPromise(
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(Layer.mergeAll(module, parent))
          expect(Option.isNone(Context.getOption(context, ListenerDependency))).toBe(true)
          yield* withTransaction(event.publish({}))
          expect(calls).toBe(1)
        }),
      )
      yield* withTransaction(event.publish({}))
      expect(calls).toBe(1)
    }).pipe(Effect.provide(event.layer)),
  )
})

test('listener database writes and their originating mutation roll back together on failure', async () => {
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database
      const mutationId = crypto.randomUUID()
      const listenerId = crypto.randomUUID()
      const event = defineEvent('test.rollback', { payload: Schema.Struct({}), concurrency: 1 })
      const writing = defineListener(event, {
        name: 'test.write',
        processing: 'transactional',
        make: Effect.succeed(
          Effect.fn('Test.write')(function* () {
            const transaction = yield* Database
            expect(transaction).toBe(yield* Transaction)
            yield* transaction`INSERT INTO test_users (id) VALUES (${listenerId})`
          }),
        ),
      })
      const failing = defineListener(event, {
        name: 'test.fail',
        processing: 'transactional',
        make: Effect.succeed(Effect.fn('Test.fail')(() => Effect.fail('listener failed' as const))),
      })
      const module = defineModule({ imports: [], internal: [], exports: [], listeners: [writing, failing] })
      const error = yield* withTransaction(
        Effect.gen(function* () {
          const transaction = yield* Database
          yield* transaction`INSERT INTO test_users (id) VALUES (${mutationId})`
          yield* event.publish({})
        }),
      ).pipe(Effect.provide(module.pipe(Layer.provideMerge(event.layer))), Effect.flip)
      expect(error).toMatchObject({
        _tag: 'EventListenerError',
        event: event.name,
        listener: 'test.fail',
        cause: 'listener failed',
      })
      expect(
        yield* db`SELECT * FROM test_users WHERE id IN (${mutationId}, ${listenerId})`,
      ).toHaveLength(0)
    }),
  )
})
