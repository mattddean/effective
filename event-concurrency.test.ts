import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { defineEvent, defineListener } from '~/framework/event.logic'
import { defineModule } from '~/framework/module.logic'
import { user } from '~/infrastructure/database.schema'
import { ShoppingDb } from '~/infrastructure/database.service'
import { withShoppingTransaction } from '~/infrastructure/transaction.operation'
import { testRuntime } from '~/test/runtime/root.runtime'

test('unbounded publication interrupts active listeners before rolling back their database writes', async () => {
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const db = yield* ShoppingDb
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
              const transaction = yield* ShoppingDb
              yield* transaction
                .insert(user)
                .values({ id, name: 'Listener', username: id, email: `${id}@example.com`, email_verified: true })
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
      const error = yield* withShoppingTransaction(event.publish({})).pipe(
        Effect.provide(module.pipe(Layer.provideMerge(event.layer))),
        Effect.flip,
      )
      expect(error).toMatchObject({ _tag: 'EventListenerError', listener: 'test.fail-after-write' })
      expect(interrupted).toBe(true)
      expect(yield* db.select().from(user).where(eq(user.id, id))).toHaveLength(0)
    }).pipe(Effect.timeout('5 seconds')),
  )
})
