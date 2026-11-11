import { Digest } from 'effect/crypto'
import { BunRuntime, BunServices } from '@effect/platform-bun'
import { PgClient } from '@effect/sql-pg'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { Activity } from 'effect/workflow'

import { WorkerCrashWorkflow } from './worker-crash-contract.js'
import { withTransaction, TestPgClientLive, TestDatabaseLive, WorkflowSqlTestStorageLive } from './database.js'
import { workflowTestNodeLayer } from './workflow.js'

const mode = Schema.decodeUnknownSync(Schema.Literals(['crash', 'recover']))(process.argv[2])
const implementation = WorkerCrashWorkflow.toLayer(
  Effect.fn('EventTest.crashRecovery')(function* (payload) {
    const client = yield* PgClient.PgClient
    yield* Activity.make({
      name: 'before-crash',
      execute: withTransaction(
        client`UPDATE effective_test_mutations SET value = value || ':activity' WHERE id = ${payload.id}`,
      ).pipe(Effect.asVoid, Effect.orDie),
    })
    // Signal only after Activity.make returns, so the test kills a worker with a completed durable checkpoint.
    yield* client`UPDATE effective_test_mutations SET value = value || ':waiting' WHERE id = ${payload.id}`.pipe(
      Effect.orDie,
    )
    if (mode === 'crash') return yield* Effect.never
    yield* Activity.make({
      name: 'after-crash',
      execute: withTransaction(
        client`UPDATE effective_test_mutations SET value = value || ':finished' WHERE id = ${payload.id}`,
      ).pipe(Effect.asVoid, Effect.orDie),
    })
  }),
)

const worker = implementation.pipe(
  Layer.provideMerge(workflowTestNodeLayer({ group: 'local', worker: true })),
  Layer.provideMerge(TestDatabaseLive),
  Layer.provide(WorkflowSqlTestStorageLive),
  Layer.provide(TestPgClientLive),
  Layer.provide(BunServices.layer),
  Layer.provide(Digest.layerWebCrypto),
)

BunRuntime.runMain(Layer.launch(worker))
