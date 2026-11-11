import { PgClient } from '@effect/sql-pg'
import * as Effect from 'effect/Effect'
import { Activity } from 'effect/workflow'

import {
  SharedConsumerTestWorkflow,
  WorkflowConsumerTestError,
} from './consumer-contract.js'

export function workflowConsumerTestLayer(
  mode: 'crash' | 'recover',
): ReturnType<typeof SharedConsumerTestWorkflow.toLayer<PgClient.PgClient>> {
  return SharedConsumerTestWorkflow.toLayer(
    Effect.fn('WorkflowConsumerTest.consume')(function* (input, executionId) {
      const client = yield* PgClient.PgClient
      yield* Activity.make({
        name: 'consumer-checkpoint',
        execute: client
          .withTransaction(client`
        INSERT INTO effective_test_workflow_consumers (case_id, event_id, consumer, calls)
        VALUES (${input.caseId}, ${executionId}, ${input.consumer}, 1)
        ON CONFLICT (event_id, consumer) DO UPDATE SET calls = effective_test_workflow_consumers.calls + 1
      `)
          .pipe(Effect.asVoid, Effect.orDie),
      })
      if (input.fail) return yield* new WorkflowConsumerTestError({ consumer: input.consumer })
      if (mode === 'crash' && input.consumer === 'second') {
        // This signal follows the durable checkpoint, so SIGKILL cannot masquerade as an activity retry.
        yield* client`UPDATE effective_test_workflow_consumers SET waiting = TRUE WHERE event_id = ${executionId} AND consumer = ${input.consumer}`.pipe(
          Effect.orDie,
        )
        return yield* Effect.never
      }
      yield* Activity.make({
        name: 'consumer-finish',
        execute: client
          .withTransaction(
            client`UPDATE effective_test_workflow_consumers SET finished = TRUE WHERE event_id = ${executionId} AND consumer = ${input.consumer}`,
          )
          .pipe(Effect.asVoid, Effect.orDie),
      })
    }),
  )
}
