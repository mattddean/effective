import * as Schema from 'effect/Schema'
import { Workflow } from 'effect/workflow'

export class WorkflowConsumerTestError extends Schema.TaggedError<WorkflowConsumerTestError>()(
  'WorkflowConsumerTestError',
  { consumer: Schema.Literals(['first', 'second']) },
) {}

// Both consumers intentionally share one native contract and its colliding business idempotency key.
export const SharedConsumerTestWorkflow = Workflow.make('effective-test-shared-consumer', {
  payload: {
    caseId: Schema.String.check(Schema.isUUID()),
    consumer: Schema.Literals(['first', 'second']),
    fail: Schema.Boolean,
  },
  error: WorkflowConsumerTestError,
  idempotencyKey: () => 'constant',
})
