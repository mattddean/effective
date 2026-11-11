import { expect, test } from 'bun:test'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { defineEvent, defineListener } from './fixtures/events.js'
import { defineModule } from '../../src/module.logic.js'
import { Database, withTransaction } from './fixtures/database.js'
import { testRuntime } from './fixtures/runtime.js'

test('unbounded publication interrupts active listeners before rolling back their database writes', async () => {
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database
      const id = crypto.randomUUID()
      const written = yield* Deferred.make<void>()
      let interrupted = false
      const event = defineEvent('test.interruption', { payload: Schema.Struct({}) })
      const writing = defineListener(event, {
        name: 'test.write-and-wait',
        processing: 'transactional',
        make: Effect.succeed(
          Effect.fn('Test.writeAndWait')(
            function* () {
              const transaction = yield* Database
              yield* transaction`INSERT INTO test_users (id) VALUES (${id})`
              yield* Deferred.succeed(written, undefined)
              return yield* Effect.never
            },
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              }),
            ),
          ),
        ),
      })
      const failing = defineListener(event, {
        name: 'test.fail-after-write',
        processing: 'transactional',
        make: Effect.succeed(
          Effect.fn('Test.failAfterWrite')(function* () {
            yield* Deferred.await(written)
            return yield* Effect.fail('listener failed' as const)
          }),
        ),
      })
      const module = defineModule({ imports: [], internal: [], exports: [], listeners: [writing, failing] })
      const error = yield* withTransaction(event.publish({})).pipe(
        Effect.provide(module.pipe(Layer.provideMerge(event.layer))),
        Effect.flip,
      )
      expect(error).toMatchObject({ _tag: 'EventListenerError', listener: 'test.fail-after-write' })
      expect(interrupted).toBe(true)
      expect(yield* db`SELECT * FROM test_users WHERE id = ${id}`).toHaveLength(0)
    }).pipe(Effect.timeout('5 seconds')),
  )
})
