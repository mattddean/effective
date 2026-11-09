import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { createEventSystem, defineServiceLayer } from '../../src/index.js'

class Input extends Context.Service<Input, { readonly value: string }>()('ServiceTypes/Input') {}
class Service extends Context.Service<Service, {
  readonly read: () => Effect.Effect<string, 'unavailable'>
}>()('ServiceTypes/Service') {}

const valid = defineServiceLayer(Service, {
  make: Input.pipe(Effect.map(input => ({ read: () => Effect.succeed(input.value) }))),
})
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type FactoryRequirementsRemain = Assert<Equal<Layer.Services<typeof valid>, Input>>
export type ServiceOutputRemains = Assert<Equal<Layer.Success<typeof valid>, Service>>

defineServiceLayer(Service, {
  // @ts-expect-error Application-service methods must resolve their dependencies.
  make: Effect.succeed({ read: () => Input.pipe(Effect.map(input => input.value)) }),
})

class WrongTransaction extends Context.Service<WrongTransaction, { readonly other: number }>()('ServiceTypes/Wrong') {}
createEventSystem({
  database: Input,
  // @ts-expect-error A transaction must carry the same database service shape.
  transaction: WrongTransaction,
})
