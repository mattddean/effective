import { BunServices } from '@effect/platform-bun'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { EventJournal } from 'effect/eventlog'
import * as Layer from 'effect/Layer'
import * as Stdio from 'effect/Stdio'
import * as Terminal from 'effect/Terminal'

import { createEventSystem } from '../../src/event.logic.js'

export class Database extends Context.Service<Database, { readonly connection: string }>()('Test/Database') {}
export class Transaction extends Context.Service<Transaction, Database['Service']>()('Test/Transaction') {}
export const { defineEvent, defineListener } = createEventSystem({ database: Database, transaction: Transaction })

export const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(Database, { connection: 'transaction' }),
    Effect.provideService(Transaction, { connection: 'transaction' }),
  )

// Composition tests need a journal, but make no SQL durability claims.
const terminal = Layer.effect(Terminal.Terminal, Effect.map(Terminal.Terminal, service => ({ ...service, display: () => Effect.void }))).pipe(Layer.provide(BunServices.layer))
const testLayer = Layer.mergeAll(BunServices.layer, Stdio.layerTest({}), terminal, EventJournal.layerMemory)
export const testRuntime = {
  runPromise: <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | EventJournal.EventJournal>) =>
    Effect.runPromise(effect.pipe(Effect.provide(testLayer))),
}
