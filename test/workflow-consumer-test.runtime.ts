// Subprocess fixture launched and killed by workflow-listeners.test.ts; not an application entry point.
import { BunRuntime, BunServices } from '@effect/platform-bun'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { workflowConsumerTestLayer } from '~/framework/test/workflow-consumer-test.workflow'
import { WorkflowSqlTestStorageLive } from '~/workflows/workflow-sql-test.layer'
import { workflowTestNodeLayer } from '~/workflows/workflow-test.layer'

const mode = Schema.decodeUnknownSync(Schema.Literals(['crash', 'recover']))(process.argv[2])
const worker = workflowConsumerTestLayer(mode).pipe(
  Layer.provide(workflowTestNodeLayer({ group: 'local', worker: true })),
  Layer.provide(WorkflowSqlTestStorageLive),
  Layer.provide(BunServices.layer),
)

BunRuntime.runMain(Layer.launch(worker))
