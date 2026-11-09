import type * as Scope from 'effect/Scope'
import type * as Types from 'effect/Types'
import type { Workflow } from 'effect/workflow'

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { SchemaBinary } from 'effect/encoding'
import { EventJournal } from 'effect/eventlog'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { WorkflowEngine } from 'effect/workflow'

import type { EventName } from './event.schema.js'

import { EventListenerError } from './event.schema.js'

type PublicationError = EventListenerError | EventJournal.EventJournalError | Schema.SchemaError

type EventListener<Payload, Database, Transaction> =
  | {
      readonly processing: 'transactional'
      readonly handle: (payload: Payload) => Effect.Effect<void, EventListenerError, Database | Transaction>
    }
  | {
      readonly processing: 'workflow'
      readonly schedule: (entry: EventJournal.Entry, payload: Payload) => Effect.Effect<void, EventListenerError>
    }

interface EventChannel<Payload, Database, Transaction> {
  readonly publish: (payload: Payload) => Effect.Effect<void, PublicationError, Transaction>
  readonly register: (listener: EventListener<Payload, Database, Transaction>) => Effect.Effect<void, never, Scope.Scope>
}

export interface TransactionalListenerDefinition<Payload, E, BuildError, R, Database, Transaction> {
  readonly name: EventName
  readonly processing: 'transactional'
  readonly make: Effect.Effect<
    (payload: Payload) => Effect.Effect<void, E, Database | Transaction>,
    BuildError,
    R
  >
}

type WorkflowPayloadSchema = Workflow.AnyStructSchema & { readonly EncodingServices: never }
type WorkflowResultSchema = Schema.Top & { readonly DecodingServices: never }

export interface WorkflowListenerDefinition<
  Payload,
  Tag extends Workflow.AnyWithProps['_tag'],
  WorkflowPayload extends WorkflowPayloadSchema,
  Success extends WorkflowResultSchema,
  Error extends WorkflowResultSchema,
> {
  readonly name: EventName
  readonly processing: 'workflow'
  readonly workflow: Workflow.Workflow<Tag, WorkflowPayload, Success, Error>
  readonly mapPayload: (payload: Payload) => WorkflowPayload['Type']
}

/** A durable domain fact, published inside the caller's transaction. */
export interface DomainEvent<Name extends EventName, Payload, Database, Transaction> {
  readonly name: Name
  readonly payload: Schema.Codec<Payload>
  readonly key: Context.Service<Name, EventChannel<Payload, Database, Transaction>>
  readonly layer: Layer.Layer<Name, never, EventJournal.EventJournal>
  readonly publish: (payload: Payload) => Effect.Effect<void, PublicationError, Name | Transaction>
}

/** Bind event publication and listeners to the application's database and transaction service keys. */
export function createEventSystem<Database, Transaction, Service>(services: {
  readonly database: Context.Key<Database, Service>
  readonly transaction: Context.Key<Transaction, NoInfer<Service>>
}) {
  const databaseService = services.database
  const transactionService = services.transaction

  /**
   * Defines a typed domain event so publishers can announce a fact without depending on its consuming modules.
   *
   * Publication inserts the journal entry, awaits every transactional listener, then persists listener workflow starts.
   * The caller owns commit through withTransaction. Any publication failure rolls back all database writes.
   * Concurrency belongs to the event definition and defaults to unbounded within each processing phase.
   */
  function defineEvent<const Name extends EventName, Payload>(
    name: Name,
    options: { readonly payload: Schema.Codec<Payload>; readonly concurrency?: Types.Concurrency },
  ): DomainEvent<Name, Payload, Database, Transaction> {
    const codec = SchemaBinary.toCodec(options.payload)
    const key = Context.Service<Name, EventChannel<Payload, Database, Transaction>>(`Event/${name}`)
    const layer = Layer.effect(
      key,
      Effect.gen(function* () {
        const journal = yield* EventJournal.EventJournal
        const listeners = new Set<EventListener<Payload, Database, Transaction>>()
        return key.of({
          publish: Effect.fn(`${name}.publish`)(function* (payload: Payload) {
            const transaction = yield* transactionService
            const registered = Array.from(listeners)
            const bytes = yield* Schema.encodeEffect(codec)(payload)
            // SqlEventJournal's callback precedes INSERT; it must not dispatch listeners.
            const entry = yield* journal.write({
              event: name,
              primaryKey: crypto.randomUUID(),
              payload: bytes.slice(),
              effect: (entry) => Effect.succeed(entry),
            })
            yield* Effect.forEach(
              registered.filter((listener) => listener.processing === 'transactional'),
              // Handlers inherit the publishing transaction rather than their construction-time database context.
              (listener) => listener.handle(payload).pipe(Effect.provideService(databaseService, transaction)),
              { concurrency: options.concurrency ?? 'unbounded', discard: true },
            )
            yield* Effect.forEach(
              registered.filter((listener) => listener.processing === 'workflow'),
              (listener) => listener.schedule(entry, payload),
              { concurrency: options.concurrency ?? 'unbounded', discard: true },
            )
          }),
          register: Effect.fn(`${name}.register`)((listener: EventListener<Payload, Database, Transaction>) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                listeners.add(listener)
              }),
              () =>
                Effect.sync(() => {
                  listeners.delete(listener)
                }),
            ),
          ),
        })
      }),
    )

    return {
      name,
      payload: options.payload,
      key,
      layer,
      publish: Effect.fn(`${name}.publish`)((payload: Payload) => key.use((channel) => channel.publish(payload))),
    }
  }

  /**
   * Registers a module-owned listener and captures its process dependencies during layer construction. Transactional
   * handlers inherit the publisher connection. Workflow listeners schedule supplied contracts; their implementations
   * register separately on workers and own their database transaction boundaries.
   */
  function defineListener<Name extends EventName, Payload, E, BuildError, R>(
    event: DomainEvent<Name, Payload, Database, Transaction>,
    options: TransactionalListenerDefinition<Payload, E, BuildError, R, Database, Transaction>,
  ): Layer.Layer<never, BuildError, R | Name>
  function defineListener<
    Name extends EventName,
    Payload,
    Tag extends Workflow.AnyWithProps['_tag'],
    WorkflowPayload extends WorkflowPayloadSchema,
    Success extends WorkflowResultSchema,
    Error extends WorkflowResultSchema,
  >(
    event: DomainEvent<Name, Payload, Database, Transaction>,
    options: WorkflowListenerDefinition<Payload, Tag, WorkflowPayload, Success, Error>,
  ): Layer.Layer<never, never, Name | WorkflowEngine.WorkflowEngine>
  function defineListener<
    Name extends EventName,
    Payload,
    E,
    BuildError,
    R,
    Tag extends Workflow.AnyWithProps['_tag'],
    WorkflowPayload extends WorkflowPayloadSchema,
    Success extends WorkflowResultSchema,
    Error extends WorkflowResultSchema,
  >(
    event: DomainEvent<Name, Payload, Database, Transaction>,
    options:
      | TransactionalListenerDefinition<Payload, E, BuildError, R, Database, Transaction>
      | WorkflowListenerDefinition<Payload, Tag, WorkflowPayload, Success, Error>,
  ): Layer.Layer<never, BuildError, R | Name | WorkflowEngine.WorkflowEngine> {
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const channel = yield* event.key
        if (options.processing === 'workflow') {
          const engine = yield* WorkflowEngine.WorkflowEngine
          yield* channel.register({
            processing: 'workflow',
            schedule: Effect.fn(`${options.name}.schedule`)(function* (entry: EventJournal.Entry, payload: Payload) {
              // Override business idempotency: each journal entry and subscription owns a separate, bounded identity.
              const identity = [options.workflow._tag, event.name, options.name, entry.idString]
                .map((part) => `${part.length}:${part}`)
                .join('')
              const digest = yield* Effect.promise(() =>
                crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)),
              )
              const executionId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
                '',
              )
              yield* engine
                .execute(options.workflow, {
                  executionId,
                  payload: options.mapPayload(payload),
                  discard: true,
                })
                .pipe(
                  Effect.mapError(
                    (cause) => new EventListenerError({ event: event.name, listener: options.name, cause }),
                  ),
                  Effect.asVoid,
                )
            }),
          })
          return
        }
        const execute = yield* options.make
        const handle = Effect.fn(options.name)((payload: Payload) =>
          execute(payload).pipe(
            Effect.mapError((cause) => new EventListenerError({ event: event.name, listener: options.name, cause })),
          ),
        )
        yield* channel.register({ processing: 'transactional', handle })
      }),
    )
  }

  return { defineEvent, defineListener }
}
