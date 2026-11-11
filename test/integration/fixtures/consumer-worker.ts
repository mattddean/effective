import { Digest } from 'effect/crypto'
// Subprocess fixture launched and killed by workflow-listeners.test.ts; not an application entry point.
import { BunRuntime, BunServices } from '@effect/platform-bun'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { workflowConsumerTestLayer } from './consumer.js'
import { WorkflowSqlTestStorageLive } from './database.js'
import { workflowTestNodeLayer } from './workflow.js'

const mode = Schema.decodeUnknownSync(Schema.Literals(['crash', 'recover']))(process.argv[2])
const worker = workflowConsumerTestLayer(mode).pipe(
  Layer.provide(workflowTestNodeLayer({ group: 'local', worker: true })),
  Layer.provide(WorkflowSqlTestStorageLive),
  Layer.provide(BunServices.layer),
  Layer.provide(Digest.layerWebCrypto),
)

BunRuntime.runMain(Layer.launch(worker))
