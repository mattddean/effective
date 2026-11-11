# Effective library guidance

Use this guidance for the installed `@mtdn.dev/effective` package. For API signatures,
inspect its `dist/index.d.ts` and `dist/storage/drizzle.d.ts` declarations.

Read [ai-docs/api.md](./ai-docs/api.md) when defining services or modules, binding database
and transaction services, or implementing event publication and listeners.

## Modules and services

Define module ownership through `imports`, `internal`, and `exports`. Only exported
services cross module boundaries. Connect sibling layers explicitly with `Layer.provide`;
putting them in the same array does not wire their dependencies. Reuse stable layer values
so Effect can share acquisition and resource lifetime.

Use `defineServiceLayer` for application services whose Effect methods have no unresolved
service requirements. Use ordinary `Layer.effect` for repositories whose methods resolve
the database service at execution, allowing callers to supply a transaction connection.

## Commands

Register resource-free command factories in their owning module. Build the command tree
from `defineModules([...]).commands`; only explicitly listed modules contribute commands.
Providers and listeners activate during execution. Help, completion, and invalid arguments
must remain free of application resource acquisition. Bind argument-dependent layers with
`Command.provide(input => layer)` at execution time.

## Events

Use the application's shared `createEventSystem({ database, transaction })` binding.
Its transaction key must carry the same database service shape as its database key.
Publish inside the application's real transaction wrapper; that wrapper supplies both keys
with the transaction connection. Journal storage and workflow storage must use the same
ambient SQL transaction for atomic publication.

Declare each event once in its owning module's `events` tuple. Consumers import the shared
event layer and register scoped listeners; they do not declare ownership again. Keep event
and module arrays inferred as tuples so duplicate-name checks remain effective.

Transactional listeners finish before workflow starts are persisted. Typed listener failures
become `EventListenerError`; the publisher owns commit and rollback. Keep irreversible
external side effects in workflows after commit. Workflow listeners reference native Effect
workflow contracts; their implementations register separately on workers.

Keep event, workflow, and listener names stable across deployments. Each journal entry and
listener gets an independent workflow execution ID. Use domain identifiers separately when
business-level deduplication is needed.
