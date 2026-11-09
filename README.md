# Effective

This guide defines Effective's architecture and authoring contract for the Express backend. Effective builds on
Effect v4 to enforce capability boundaries, application-service contracts, and durable domain events.

Backward compatibility is not required. Prefer clean breaks when evolving framework APIs: update all callers,
documentation, and tests together, and remove obsolete APIs rather than adding compatibility shims or deprecated aliases.

## Architectural basis

Effective uses NestJS's module ownership model as a design reference and Effect's typed layers for dependency
composition. These are architectural references, not dependencies on NestJS or its decorator-based container.

- [NestJS modules](https://docs.nestjs.com/modules) define provider ownership and visibility: local providers are
  encapsulated, imports expose another module's exports, and exports form the public interface. Registering a
  provider in a root module does not automatically make it global.
- [NestJS's Nest Commander recipe](https://docs.nestjs.com/recipes/nest-commander) registers commands as injectable
  module providers. Its [standalone application model](https://docs.nestjs.com/standalone-applications) reuses the
  module graph without starting an HTTP listener. Nest Commander is a third-party integration documented by NestJS.
- [Effect v4 layers](https://effect.website/docs/v4/requirements-management/layers) express construction dependencies
  and errors in types. `Layer.provide` connects dependencies; merging layers combines their outputs without wiring
  dependencies between siblings. [Layer memoization](https://effect.website/docs/v4/requirements-management/layer-memoization)
  shares stable layer instances within a construction graph; Effect scopes manage resource lifetime.

For version-specific implementation details, use the installed [Effect instructions](../node_modules/effect/AGENTS.md),
[layer composition examples](../node_modules/effect/ai-docs/src/01_effect/03_services/20_layer-composition.ts), and
[CLI API](../node_modules/effect/src/cli/Command.ts). `Command.provide` accepts either a layer or a function that
selects a layer from parsed command input.

A module declares its providers once, and its services and commands consume that same dependency graph.
Effective also requires resource-free help, preservation of transaction connections, and explicit event activation.

## Application services

[`defineServiceLayer`](./service.logic.ts) constructs an application service's layer:

```ts
static readonly layer = defineServiceLayer(PostsService, { make: makePosts })
```

The service's Effect methods must have no unresolved service requirements. If a method publishes an event without
supplying its transaction, the diagnostic appears at this declaration and identifies the offending method, instead
of surfacing later at the HTTP handler. Arguments, success types, error types, and value properties remain inferred.

The service factory can still require process dependencies; those requirements and construction errors remain on
the layer. Repositories use `Layer.effect` directly because their methods intentionally retain `ShoppingDb` so they
can participate in the caller's transaction.

## Capability modules

[`defineModule`](./module.logic.ts) composes a capability into an ordinary Effect layer:

| Field       | Purpose                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `imports`   | Supply dependencies from other capabilities.                            |
| `internal`  | Supply private dependencies, including repository layers.               |
| `exports`   | Define the public services exposed by the module.                       |
| `events`    | Declare the event contracts owned by the module.                        |
| `listeners` | Acquire scoped event subscriptions without exposing their dependencies. |
| `commands`  | Register Effect factories for the capability's CLI command groups.      |

Only `exports` appear in the module's public context. Infrastructure requirements and construction errors remain
for the runtime root to handle. Sibling layers need explicit `Layer.provide` wiring; listing them together does not
connect them. Keep shared layer values stable so Effect memoization can share their acquisition and lifetime.

### CLI commands

#### Registration

Each capability owns its command groups and subcommands in `.command.ts` files and registers their factories in
its `.module.ts` definition:

```ts
export const IdentityModule = defineModule({
  imports: [],
  internal: [AccountRepository.layer],
  exports: [AccountsService.layer, AuthorizationService.layer],
  commands: [makeUsersCommand],
})
```

Every `make…Command` is an Effect producing an Effect CLI `Command`. Use `Effect.succeed` for groups without
construction dependencies and `Effect.gen` to resolve resource-free configuration or layer factories. Constructing
a command tree must not acquire connections, perform application I/O, or run handlers: construction also runs for
help and completion.

`defineModules` collects the explicitly registered modules' command factories in `.commands`. It does not collect
commands recursively from imports, which would duplicate shared capabilities. The CLI runs
`Effect.all(ShoppingServicesLayer.commands)` and passes the resulting groups to `Command.withSubcommands`.
Keep the executable-free command tree in [`commands.command.ts`](../commands.command.ts) so tests can exercise
the same registration and parsing as the process entry point.

#### Module dependencies

Commands consume their owning module's declared providers. The framework supplies these dependencies when the
selected handler executes, preserving Effect's explicit wiring and type inference:

| Declaration | Command visibility                                                                           |
| ----------- | -------------------------------------------------------------------------------------------- |
| `imports`   | Public services exported by the imported capabilities.                                       |
| `internal`  | Private providers available within the owning module, including its commands.                |
| `exports`   | The module's public service implementations, also usable by its own commands.                |
| `commands`  | Module-owned command groups whose dependencies are satisfied through the declarations above. |

Only `exports` cross the public module boundary. Making a private repository available to an owning command must
not export it into the application context or make it available to commands in other modules. Cross-module work
uses the other module's public application services. Declare explicit wiring between sibling layers once in the
module's layer composition and reuse it for services and commands.

For example, a password command requires `AccountRepository`; its owning module declares
`internal: [AccountRepository.layer]`. The framework supplies that repository to the command. The handler retains
its typed requirements, and the command and executable do not repeat the repository layer declaration.

#### Ownership, configuration, and lifetime

Treat these as separate decisions:

- **Ownership:** capability modules declare their providers and imported interfaces. Infrastructure providers can
  be composed through infrastructure layers or modules, with explicit requirements wherever they are consumed.
- **Configuration:** the process composition selects deployed implementations and supplies environment settings.
  Values from CLI arguments, such as `--worker`, configure the selected execution. Where a value becomes available
  does not change which module owns the consumer or which providers it may access.
- **Lifetime:** Effect layers and scopes acquire, share, and release resources. A command can use
  `Command.provide(input => layer)` to bind parsed configuration at execution time. The framework must preserve
  that scope and shared layer identities when supplying module dependencies.

[`commands.runtime.ts`](../commands.runtime.ts) bootstraps the application's chosen module composition, supplies
remaining process requirements, and runs the CLI with its platform services and observability. It must not enumerate
individual command groups or duplicate module-private provider wiring. Adding a command or subcommand changes its
owning module; adding a new capability or changing deployment configuration can change the application composition.

Declare deployment layers in [`runtime/layers/commands.layer.ts`](../runtime/layers/commands.layer.ts). Module services
and listeners use the process's configured workflow client. Only commands that explicitly invoke worker workflows
declare `--worker`: it selects the `default` or `local` workflow group and defaults to `default`. The command handler
runs in the CLI process; the flag routes its workflow invocations and does not select a database or execute the
command remotely.

Each workflow-triggering command owns a `make…Command` factory that resolves `WorkflowClientFactory` during command
construction and binds its unbuilt layer with `Command.provide(({ worker }) => makeWorkflowClient(worker))`. Its parent
group assembles the subcommands without knowing their flags or workflow-client configuration. The selected client is
scoped to that handler's workflow invocations. Command construction and help must not build it. Commands that do not
invoke worker workflows do not declare or accept `--worker`.

Dependency visibility and feature activation must remain distinct. Help, completion, and invalid arguments must
not acquire application resources. Executing a command must not unintentionally start HTTP servers or workflow
workers. A command that publishes domain events still needs the appropriate journal and listener composition;
omitting listeners to simplify CLI startup must not silently change mutation semantics. Commands that only trigger
workflows use a client-only workflow engine. These lifecycle rules must be tested alongside dependency composition.
`defineModules` activates the declared application graph during command execution, including all of its listeners.
This activation keeps service outputs hidden; each command receives only its own module's declared providers.

#### Testing

Framework tests must verify that:

1. A command receives its module's private and public providers and imported public services without re-providing them.
2. Private providers remain absent from public layer outputs and unavailable across module boundaries.
3. Unsatisfied requirements and construction/handler errors remain in the inferred types.
4. Shared layer instances are acquired once per execution scope and released on success, failure, and interruption.
5. Help, completion, and invalid input acquire no application resources; selected execution activates only its intended runtime features.
6. Test providers replace production infrastructure while repository calls retain the ambient transaction connection.

Run database-backed command tests through `testRuntime` with the module's registered command tree. The test
runtime supplies infrastructure; tests can replace input-dependent providers when exercising worker selection.
Do not import the executable `commands.runtime.ts` or provide production layers in those tests. Keep framework
registration, dependency visibility, type inference, and lifecycle tests in
[`module-commands.test.ts`](./module-commands.test.ts).

## Durable domain events

[`defineEvent`](./event.logic.ts) defines a typed domain fact in the publishing capability's `.event.ts` contract.
Consuming capabilities own `.listener.ts` layers built with `defineListener`. Register these layers in the owning
module's `listeners` array; publishers remain independent of their consumers.

Declare owned event contracts in the publishing module:

```ts
defineModule({
  imports: [IdentityModule],
  internal: [PostRepository.layer],
  exports: [PostsService.layer],
  events: [PostCreated, CommentCreated, ReactionCreated],
})
```

Compose the application's owning modules with `defineModules([MomentsModule, NotificationsModule, ...])`.
TypeScript rejects duplicate event names within a module and across that composition, even when the payload
schemas are identical. Event and module lists must remain inferred tuples so their names can be checked.
Consumers import the publisher's shared event layers; referencing an event does not declare ownership.
Stable layers share their channels through Effect's normal memoization. There is no runtime name registry.

```mermaid
flowchart TD
  subgraph Transaction["Transaction provided and owned by the publisher"]
    Publisher["Publishing module: <br/>create or update domain data"]
    subgraph Publication["Effective participates in the provided transaction"]
      Publish["Publish typed event"]
      Journal["1. Insert EventJournal entry<br/>even with no listeners"]
      Inline["2. Await <code>transactional</code> <br/>listeners on the same connection"]
      Starts["3. Persist an Effect Workflow <br/>start for each <code>workflow</code> listener <br/>(outbox)"]
      Publish --> Journal --> Inline --> Starts
    end
    Return["4. Return to publisher<br/>transaction still open;<br/>without waiting for workflows"]
    Continue["Publisher continues its work<br/>in the same transaction"]
    Commit["Publisher commits all <br/>writes together"]
    Publisher --> Publish
    Starts --> Return --> Continue --> Commit
  end
  Journal -. Failure .-> Rollback["Roll back domain data, journal entry,<br/>listener writes, <br/>and workflow starts"]
  Inline -. Failure .-> Rollback
  Starts -. Failure .-> Rollback
  Continue -. Failure .-> Rollback
  Commit -. Failure .-> Rollback
  Commit --> Workers
  subgraph Workers["Process <code>workflow</code> listeners after commit"]
    A["Effect Workflow A<br/>activities, third-party calls, <br/>durable waits"]
    B["Effect Workflow B<br/>activities, third-party calls, <br/>durable waits"]
    Recovery["Worker restart resumes <br/>unfinished workflows from <br/>durable checkpoints"]
    Recovery -.-> A
    Recovery -.-> B
  end
```

`publish` uses the supplied transaction and returns before it commits. The publisher can continue writing, then
commit or roll back all writes together. Workflow implementations own their database transaction boundaries;
the publisher's transaction ends at commit.
One workflow's failure cannot roll back publication or stop another consumer. Each journal entry and listener has
its own workflow execution identity, while the journal remains an independent history of committed facts.

Each listener declares `processing: 'transactional'` or `processing: 'workflow'`. Both modes can consume the same event.
Transactional listeners use `make` to capture process dependencies and construct an inline handler. They keep their
database requirements so publication supplies the publisher's connection.

Workflow listeners reference a native `.workflow-contract.ts` definition and map the event into its typed payload:

```ts
defineListener(CommentCreated, {
  name: 'notifications.created-comment',
  processing: 'workflow',
  workflow: ShoppingCommentNotificationWorkflow,
  mapPayload: (event) => ({
    commentEventId: event.commentId,
    commenterId: event.authorId,
    organizationId: event.organizationId,
    postId: event.postId,
    teamId: event.teamId,
  }),
})
```

Register the workflow's `.workflow.ts` implementation on the worker through its normal `toLayer` composition.
Effective persists the supplied workflow's start directly. There are no generated listener workflows and no listener
`discard` option: publication always schedules with `discard: true`. To wait for completion, call the workflow directly
with `discard: false` outside the publishing transaction, as deletion workflows do.

Payload encoding and result decoding schemas must not require additional services. Deliveries use a stable hash of the
workflow name, event name, listener name, and journal entry ID. This overrides the workflow's business idempotency key:
separate events and separate listeners remain independent even when they share a contract with a constant key.
Notification claims still use domain comment/reaction IDs to deduplicate actual delivery.

Workflow handlers execute independently after commit and own their database transaction boundaries. The engine never
wraps workflow execution in a transaction. Keep third-party calls and durable waits outside explicit database transactions.

`publish(payload)` requires `ShoppingTransaction`. Inside the mutation's `withShoppingTransaction` boundary it:

1. Encodes the typed payload and inserts a native EventJournal entry, even with no listeners.
2. Awaits every transactional listener using the publisher's transaction.
3. Persists an independent workflow start record for each async listener.
4. Returns to the transaction owner, which commits all database writes together.

A journal insert failure invokes no handlers. Transactional listener errors, workflow storage failures, and commit
failures roll back the mutation, journal entry, listener database writes, and workflow starts together. Inline external
side effects cannot be undone by database rollback. Typed listener failures become
[`EventListenerError`](./event.schema.ts); defects and interruption propagate through the transaction boundary.

Workers process workflow listeners after commit. Publication does not await workflow completion, and execution failure
does not undo publication or prevent other consumers from succeeding. Keep workflow, event, and listener names stable
across publisher and worker deployments. Unfinished jobs recover on worker restart; completed deliveries retain native
workflow deduplication until workflow storage is cleared. Journal history survives that cleanup independently.

Event concurrency defaults to `unbounded`; `1` runs sequentially. The limit applies separately to transactional handlers
and async scheduling, with the entire transactional phase finishing before workflow scheduling begins. Each publication snapshots
the current subscriptions; scoped layers unregister when disposed.

Modules supply their owned event channels; consumers import the shared event layers. Compose
[`EventJournalLive`](./event-journal.layer.ts) at the runtime root. Supply the same
SQL client layer used by `ShoppingDb` and workflow storage so ambient SQL transactions span all three. Build the owning
module layers on workers too; the production API and worker roots both do this. Client-only publishers register workflow
contracts without executing the jobs locally.

Effect's `SqlEventJournal` creates and owns `effect_event_journal` and `effect_event_remotes`. Effect cluster storage owns
the workflow tables. [`event-journal.schema.ts`](./event-journal.schema.ts) and
[`workflow-storage.schema.ts`](./workflow-storage.schema.ts) describe these tables for reading; they are not application
migration inputs. The Effect 4.0.0 [dependency patch](../../../patches/effect@4.0.0.patch) fixes native PostgreSQL UUID
bindings and bigint timestamp decoding. Recheck it when upgrading Effect.

See the [post-created contract](../modules/moments/post-created.event.ts), its
[notification listener](../modules/notifications/post-created.listener.ts), and the
[post creation operation](../modules/moments/post.operation.ts) for production usage. The post notification listener
remains transactional because its batch writes and notification workflow start belong to post creation's transaction.
Comment and reaction listeners reference native workflow contracts; processing and durable activities live in their `.workflow.ts` implementations. Their notification
claims and listener workflow keys retain the domain comment/reaction IDs for deduplication. Each new journal entry
remains a separate historical record even when its async work reuses an existing workflow.

## Verification

Keep helper documentation and focused tests aligned when changing a contract. Service inference and rejection of
unresolved transaction requirements are checked in [service-layer.types.ts](../test/service-layer.types.ts). Runtime
coverage lives in [module.test.ts](./module.test.ts), [event.test.ts](./event.test.ts), and
[event-concurrency.test.ts](./event-concurrency.test.ts), including private contexts, subscription lifetime, concurrency,
and transaction rollback. Each product requirement is described in
[durable-events.test.ts](./durable-events.test.ts), including real storage and commit failures, ordering, mixed listeners,
restart recovery, and history retention. [storage-schema.test.ts](./storage-schema.test.ts) checks the read schemas
against Effect's installed table definitions. [module-events.test.ts](./module-events.test.ts) invokes the TypeScript
compiler to verify duplicate-name rejection and valid consumer reuse. [post.e2e.test.ts](../modules/moments/post.e2e.test.ts) exercises the same
guarantees through the post service and HTTP endpoint.
