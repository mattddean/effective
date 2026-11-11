import * as Schema from 'effect/Schema'
import { Workflow } from 'effect/workflow'

export const WorkerCrashWorkflow = Workflow.make('effective-test-worker-crash', {
  payload: { id: Schema.String.check(Schema.isUUID()) },
  idempotencyKey: (payload) => payload.id,
})
