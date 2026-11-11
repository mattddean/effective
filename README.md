# Effective

Effective is a lightweight framework for Effect V4 that makes you incredibly effective at building large, modularized applications. It's inspired by NestJS modules and "modular monolith" patterns.

## Installation

```sh
npm install @mtdn.dev/effective effect
```

If you're writing with agents, add the skill:

```sh
npx skills@1.7.3 add mattddean/effective
```

Then execute the skill to give your agent context about how effective works.

## Modules

`defineModule` composes a capability into an ordinary Effect layer:

| Field       | Purpose                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `imports`   | Supply dependencies from other capabilities.                            |
| `internal`  | Supply private dependencies, including repository layers.               |
| `exports`   | Define the public services exposed by the module.                       |
| `events`    | Declare the event contracts owned by the module.                        |
| `listeners` | Acquire scoped event subscriptions without exposing their dependencies. |
| `commands`  | Register Effect factories for the capability's CLI command groups.      |

## Durable domain events

You can define an event and then listen to it with two kinds of listeners. The publisher doesn't care how its listeners want to listen (although a future iteration should provide a way to create a type of event that is only listenable via one of the other):
- `transactional`: A listener can be transactional, simply meaning that it participates in the transaction of the publisher. At compile time, we require that a transaction is provided via DI. E.g. emitAsync from NestJS.
- `workflow`: Or a listener can be a workflow, meaning that it does not participate in the transaction and can have multiple steps (Activity.make's).

Events are durably stored in a table, using Effect's `SqlEventJournal`, even if they have no listeners or all their listeners are `transactional`.

Naturally supports resuming workflows if a process dies. That's just how Effect Workflow works.

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

## CLI commands

Each capability owns its command groups and subcommands in `.command.ts` files and registers their factories in its `.module.ts` definition.

## Storage read models

PostgreSQL Drizzle read models are exported from `@mtdn.dev/effective/storage/drizzle`.
Install the optional `drizzle-orm` peer to use them. Import only the tables you need;
unused tables can be tree-shaken. This replaces the previous `/storage` entry.
Effect owns table creation and migrations.

```ts
import { clusterMessages, eventJournal } from '@mtdn.dev/effective/storage/drizzle'
```

## Tests

`bun run check` runs type checks, unit and automation tests, PostgreSQL integration tests,
and package validation. Docker must be running; Testcontainers creates and removes a
PostgreSQL 17 database without using deployment credentials. Run just the database suite
with `bun run test:integration`, or the resource-free suites with
`bun test test/unit test/automation`.

CI repeats the integration suite for every supported Effect version. The schema test
compares all exported read models with the tables created by Effect, checking column names,
SQL types, nullability, and primary-key membership. The extracted Junior event suites also
cover concurrency and interruption, commit visibility and rollback, durable workflow
starts, independent consumers, and recovery after a worker is killed.
