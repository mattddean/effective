import type { WorkflowEngine } from 'effect/workflow'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Workflow } from 'effect/workflow'

import { defineListener, type DomainEvent, type TransactionalListenerDefinition } from './events.js'
import { EventListenerError, type EventName } from '../../../src/event.schema.js'
import { Database, Transaction } from './database.js'

export type ListenerFixtureDefinition<Payload, E, BuildError, R> =
  | TransactionalListenerDefinition<Payload, E, BuildError, R, Database, Transaction>
  | {
      readonly name: EventName
      readonly processing: 'workflow'
      readonly make: Effect.Effect<
        (
          payload: Payload,
        ) => Effect.Effect<void, E, Database | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>,
        BuildError,
        R
      >
    }

// Test fixtures define and register their own native workflows; Effective only binds their contracts to events.
export function listenerFixture<Name extends EventName, Payload, E, BuildError, R>(
  event: DomainEvent<Name, Payload, Database, Transaction>,
  options: ListenerFixtureDefinition<Payload, E, BuildError, R>,
): Layer.Layer<never, BuildError, R | Name | Database | WorkflowEngine.WorkflowEngine> {
  if (options.processing === 'transactional') return defineListener(event, options)
  const workflow = Workflow.make(`EffectiveTest/${event.name}/${options.name}`, {
    payload: { event: event.payload },
    error: EventListenerError,
    idempotencyKey: () => 'fixture',
  }).annotate(Workflow.CaptureDefects, true)
  const implementation = Layer.unwrap(
    Effect.gen(function* () {
      const execute = yield* options.make
      const db = yield* Database
      return workflow.toLayer(
        Effect.fn(`${options.name}.workflow`)((input) =>
          execute(input.event).pipe(
            Effect.provideService(Database, db),
            Effect.mapError((cause) => new EventListenerError({ event: event.name, listener: options.name, cause })),
          ),
        ),
      )
    }),
  )
  return defineListener(event, {
    name: options.name,
    processing: 'workflow',
    workflow,
    mapPayload: (payload) => ({ event: payload }),
  }).pipe(Layer.provideMerge(implementation))
}
