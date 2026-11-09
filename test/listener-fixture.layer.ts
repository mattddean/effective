import type { WorkflowEngine } from 'effect/workflow'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Workflow } from 'effect/workflow'

import { defineListener, type DomainEvent, type TransactionalListenerDefinition } from '~/framework/event.logic'
import { EventListenerError, type EventName } from '~/framework/event.schema'
import { ShoppingDb } from '~/infrastructure/database.service'

export type ListenerFixtureDefinition<Payload, E, BuildError, R> =
  | TransactionalListenerDefinition<Payload, E, BuildError, R>
  | {
      readonly name: EventName
      readonly processing: 'workflow'
      readonly make: Effect.Effect<
        (
          payload: Payload,
        ) => Effect.Effect<void, E, ShoppingDb | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance>,
        BuildError,
        R
      >
    }

// Test fixtures define and register their own native workflows; Effective only binds their contracts to events.
export function listenerFixture<Name extends EventName, Payload, E, BuildError, R>(
  event: DomainEvent<Name, Payload>,
  options: ListenerFixtureDefinition<Payload, E, BuildError, R>,
): Layer.Layer<never, BuildError, R | Name | ShoppingDb | WorkflowEngine.WorkflowEngine> {
  if (options.processing === 'transactional') return defineListener(event, options)
  const workflow = Workflow.make(`EffectiveTest/${event.name}/${options.name}`, {
    payload: { event: event.payload },
    error: EventListenerError,
    idempotencyKey: () => 'fixture',
  }).annotate(Workflow.CaptureDefects, true)
  const implementation = Layer.unwrap(
    Effect.gen(function* () {
      const execute = yield* options.make
      const db = yield* ShoppingDb
      return workflow.toLayer(
        Effect.fn(`${options.name}.workflow`)((input) =>
          execute(input.event).pipe(
            Effect.provideService(ShoppingDb, db),
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
