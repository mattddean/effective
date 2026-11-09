# Effective API

These examples use the ESM package `@mtdn.dev/effective` with Effect 4.1.2.
Effective exports `defineModule`, `defineModules`, `defineServiceLayer`,
`createEventSystem`, `EventListenerError`, `eventNameSchema`, and `EventJournalLive`.
`DomainEvent`, `TransactionalListenerDefinition`, `WorkflowListenerDefinition`, and
`EventName` are public types. PostgreSQL Drizzle read models are available separately
from `@mtdn.dev/effective/storage`; that entry requires `drizzle-orm`.

## Service and module

```ts
import { defineModule, defineServiceLayer } from '@mtdn.dev/effective'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'

class Greeting extends Context.Service<Greeting, {
  readonly hello: () => Effect.Effect<string>
}>()('example/Greeting') {
  static readonly layer = defineServiceLayer(Greeting, {
    make: Effect.succeed({ hello: () => Effect.succeed('hello') }),
  })
}

export const GreetingModule = defineModule({
  imports: [],
  internal: [],
  exports: [Greeting.layer],
})
```

`imports` supplies other modules' public services; `internal` supplies private providers.
`exports` determines the public layer output. `events`, `listeners`, and `commands` are
optional. `defineModules([ModuleA, ModuleB])` composes the application and collects
commands without recursively collecting imported modules' commands.

`defineServiceLayer` checks unresolved requirements on Effect-returning service methods
at the factory declaration. Factory dependencies and construction errors remain on the layer.

## Bind database and transaction services

Bind once and share the returned functions throughout the application. Applications using
Drizzle can substitute their database service shape and their own transaction wrapper.
This example uses Effect's SQL client directly:

```ts
import { createEventSystem } from '@mtdn.dev/effective'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'

export class Database extends Context.Service<Database, SqlClient.SqlClient>()('example/Database') {}
export class Transaction extends Context.Service<Transaction, Database['Service']>()('example/Transaction') {}
export const { defineEvent, defineListener } = createEventSystem({
  database: Database,
  transaction: Transaction,
})

export const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(effect.pipe(
      Effect.provideService(Database, sql),
      Effect.provideService(Transaction, sql),
    ))
  })

export const PostCreated = defineEvent('posts.created', {
  payload: Schema.Struct({ id: Schema.String }),
})

export const mutation = withTransaction(PostCreated.publish({ id: 'post-1' }))
```

The program still needs `PostCreated.layer`, `EventJournalLive`, and a concrete SQL client
layer at the runtime root. Reuse the same SQL client layer for domain data, journal storage,
and persistent workflow storage. The transaction key is a capability marker: supplying it
without opening a real transaction does not provide atomicity.

## Listeners and lifetime

A transactional listener is defined with:

```ts
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { defineEvent, defineListener } from './events.js'

const ExampleCreated = defineEvent('example.created', {
  payload: Schema.Struct({ id: Schema.String }),
})

export const listener = defineListener(ExampleCreated, {
  name: 'projection.example-created',
  processing: 'transactional',
  make: Effect.succeed((_payload) => Effect.void),
})
```

The `./events.js` import above refers to the application's shared binding from the preceding
example. Register the listener in its module's `listeners` array. Its `make` captures process
dependencies; its handler may require the database and transaction services supplied during
publication. Resolve the database in the handler rather than capturing a construction-time
connection in `make`.

Workflow listeners instead specify `processing: 'workflow'`, `workflow`, and `mapPayload`.
Provide a persistent Effect workflow engine at publication and register the contract's
implementation on workers. Effective persists starts with `discard: true`; it does not
wait for workflow completion. In-memory engines are useful for tests but do not establish
production durability or post-commit execution.

Event concurrency defaults to `unbounded` and applies separately to inline handling and
workflow scheduling. `concurrency: 1` makes each phase sequential. Disposing the listener's
scope unregisters its subscription.
