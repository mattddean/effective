import { expect, test } from 'bun:test'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import { defineModule } from '~/framework/module.logic'

class Input extends Context.Service<Input, { readonly value: number }>()('ModuleTest/Input') {}
class Imported extends Context.Service<Imported, Input['Service']>()('ModuleTest/Imported') {}
class Internal extends Context.Service<Internal, Input['Service']>()('ModuleTest/Internal') {}
class First extends Context.Service<First, Input['Service']>()('ModuleTest/First') {}
class Second extends Context.Service<Second, { readonly first: First['Service'] }>()('ModuleTest/Second') {}

const imported = Layer.effect(Imported, Input)
const internal = Layer.effect(Internal, Imported)
const first = Layer.effect(First, Internal)
const second = Layer.effect(
  Second,
  Effect.map(First, (first) => ({ first })),
)

const disconnected = defineModule({
  imports: [imported],
  internal: [internal],
  exports: [first, second],
})
const connected = defineModule({
  imports: [imported],
  internal: [internal],
  exports: [first, second.pipe(Layer.provide(first))],
})
const failing = defineModule({
  imports: [Layer.effect(Imported, Effect.fail('unavailable' as const))],
  internal: [internal],
  exports: [first],
})

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<Condition extends true> = Condition

export type MissingSiblingIsRequired = Assert<Equal<Layer.Services<typeof disconnected>, Input | First>>
export type OnlyInfrastructureIsRequired = Assert<Equal<Layer.Services<typeof connected>, Input>>
export type OnlyPublicServicesAreExposed = Assert<Equal<Layer.Success<typeof connected>, First | Second>>
export type ConstructionErrorsArePreserved = Assert<Equal<Layer.Error<typeof failing>, 'unavailable'>>

test('explicit sibling wiring shares the exported service and hides imports and internals', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(connected)
      const publicFirst = Context.get(context, First)
      expect(publicFirst.value).toBe(42)
      expect(Context.get(context, Second).first).toBe(publicFirst)
      expect(Option.isNone(Context.getOption(context, Internal))).toBe(true)
      expect(Option.isNone(Context.getOption(context, Imported))).toBe(true)
    }).pipe(Effect.scoped, Effect.provideService(Input, { value: 42 })),
  )
})

test('a module import shared with the root is acquired and released once', async () => {
  let acquisitions = 0
  let releases = 0
  const shared = Layer.effect(
    Imported,
    Effect.acquireRelease(
      Effect.sync(() => {
        acquisitions++
        return { value: 42 }
      }),
      () =>
        Effect.sync(() => {
          releases++
        }),
    ),
  )
  const module = defineModule({ imports: [shared], internal: [internal], exports: [first] })
  await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.merge(module, shared))
      expect(Context.get(context, First)).toBe(Context.get(context, Imported))
      expect(acquisitions).toBe(1)
      expect(releases).toBe(0)
    }).pipe(Effect.scoped),
  )
  expect(releases).toBe(1)
})

test('module construction retains dependency failures', async () => {
  const result = await Effect.runPromise(
    Layer.build(failing).pipe(
      Effect.scoped,
      Effect.match({ onFailure: (error) => error, onSuccess: () => 'built' as const }),
    ),
  )
  expect(result).toBe('unavailable')
})

test('modules can export a layer without imports or internals', async () => {
  const module = defineModule({ imports: [], internal: [], exports: [Layer.succeed(First, { value: 42 })] })
  const result = await Effect.runPromise(First.pipe(Effect.provide(module)))
  expect(result.value).toBe(42)
})
