import * as Schema from 'effect/Schema'

import { defineEvent } from '~/framework/event.logic'

// Shared by the publisher test and its separate worker processes.
export const WorkerCrashFact = defineEvent('effective.worker-crash', {
  payload: Schema.Struct({ id: Schema.String.check(Schema.isUUID()) }),
})
