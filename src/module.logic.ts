import type { Command } from 'effect/cli'
import type * as Effect from 'effect/Effect'

import * as Layer from 'effect/Layer'

import type { EventName } from './event.schema.js'

import { provideCommands, type ProvidedCommandFactory } from './command.logic.js'

type Layers = ReadonlyArray<Layer.Any>
type ModuleEvent = { readonly name: EventName; readonly layer: Layer.Any }
type Events = ReadonlyArray<ModuleEvent>
type EventOwner = { readonly events: Events | undefined }
type Module<E, R, CE, CR> = Layer.Layer<never, E, R> &
  EventOwner & {
    readonly commands: ReadonlyArray<Effect.Effect<Command.Command.Any, CE, CR>>
  }

type ModuleError<
  Imports extends Layers,
  Internal extends Layers,
  Exports extends Layers,
  Listeners extends Layers,
  Owned extends Events,
> = Layer.Error<Exports[number] | Internal[number] | Imports[number] | Listeners[number] | Owned[number]['layer']>
type ModuleRequirements<
  Imports extends Layers,
  Internal extends Layers,
  Exports extends Layers,
  Listeners extends Layers,
  Owned extends Events,
> =
  | Layer.Services<Imports[number]>
  | Exclude<
      | Layer.Services<Owned[number]['layer']>
      | Exclude<
          | Layer.Services<Internal[number]>
          | Exclude<Layer.Services<Exports[number] | Listeners[number]>, Layer.Success<Internal[number]>>,
          Layer.Success<Owned[number]['layer']>
        >,
      Layer.Success<Imports[number]>
    >

type UniqueEvents<Owned extends Events, Seen extends EventName = never> = number extends Owned['length']
  ? { readonly eventNamesRequireATuple: true }
  : Owned extends readonly [infer First extends ModuleEvent, ...infer Rest extends Events]
    ? Extract<First['name'], Seen> extends never
      ? UniqueEvents<Rest, Seen | First['name']>
      : { readonly duplicateEventName: Extract<First['name'], Seen> }
    : Record<never, never>

type UniqueModules<
  Modules extends ReadonlyArray<EventOwner>,
  Seen extends EventName = never,
> = number extends Modules['length']
  ? { readonly modulesRequireATuple: true }
  : Modules extends readonly [infer First extends EventOwner, ...infer Rest extends ReadonlyArray<EventOwner>]
    ? Extract<NonNullable<First['events']>[number]['name'], Seen> extends never
      ? UniqueModules<Rest, Seen | NonNullable<First['events']>[number]['name']>
      : { readonly duplicateEventName: Extract<NonNullable<First['events']>[number]['name'], Seen> }
    : Record<never, never>

/**
 * Composes a capability into an ordinary Effect layer exposing only its public exports.
 *
 * Internal layers supply private dependencies to exports, listeners, and commands; imports supply dependencies to those
 * layers and the internals. Commands acquire this same graph at execution, retaining private providers only locally.
 * Infrastructure requirements and construction errors remain on the result for the runtime root to handle.
 *
 * Listing sibling layers does not wire them together; connect sibling dependencies explicitly with Layer.provide.
 */
export function defineModule<
  CommandError,
  CommandRequirements,
  const Imports extends Layers,
  const Internal extends Layers,
  const Exports extends Layers,
  const Listeners extends Layers = [],
  const Owned extends Events = [],
  const Commands extends ReadonlyArray<Effect.Effect<Command.Command.Any, CommandError, CommandRequirements>> = [],
>(definition: {
  readonly imports: Imports
  readonly internal: Internal
  readonly exports: Exports
  readonly listeners?: Listeners
  readonly events?: Owned & UniqueEvents<Owned>
  readonly commands?: Commands
}): Layer.Layer<
  Layer.Success<Exports[number]>,
  ModuleError<Imports, Internal, Exports, Listeners, Owned>,
  ModuleRequirements<Imports, Internal, Exports, Listeners, Owned>
> & {
  readonly events: Owned | undefined
  readonly commands: ReadonlyArray<
    ProvidedCommandFactory<
      Commands[number],
      Layer.Success<Exports[number] | Internal[number] | Imports[number] | Owned[number]['layer']>,
      ModuleError<Imports, Internal, Exports, Listeners, Owned>,
      ModuleRequirements<Imports, Internal, Exports, Listeners, Owned>
    >
  >
} {
  const listeners = Layer.empty.pipe(Layer.provide([Layer.empty, ...(definition.listeners ?? [])]))
  const dependencies = Layer.empty.pipe(
    Layer.merge([Layer.empty, ...definition.internal]),
    Layer.provideMerge([Layer.empty, ...(definition.events ?? []).map((event) => event.layer)]),
    Layer.provideMerge([Layer.empty, ...definition.imports]),
  )
  const layer = Layer.empty.pipe(
    Layer.merge([Layer.empty, ...definition.exports, listeners]),
    Layer.provide(dependencies),
  )
  return Object.assign(layer, {
    events: definition.events,
    commands: provideCommands(definition.commands ?? [], { layer: Layer.merge(layer, dependencies) }),
  })
}

/** Composes owning modules and rejects duplicate event names before the application can compile. */
export function defineModules<E, R, CE, CR, const Modules extends [Module<E, R, CE, CR>, ...Module<E, R, CE, CR>[]]>(
  modules: Modules & UniqueModules<Modules>,
): Layer.Layer<Layer.Success<Modules[number]>, Layer.Error<Modules[number]>, Layer.Services<Modules[number]>> & {
  readonly commands: ReadonlyArray<
    ProvidedCommandFactory<
      Modules[number]['commands'][number],
      never,
      Layer.Error<Modules[number]>,
      Layer.Services<Modules[number]>
    >
  >
} {
  const layers: Modules = modules
  const layer = Layer.mergeAll<Modules>(...layers)
  // Activate every declared listener without granting commands access to undeclared module exports.
  const activation = Layer.empty.pipe(Layer.provide(layer))
  const commands = modules.flatMap((module): ReadonlyArray<Modules[number]['commands'][number]> => module.commands)
  return Object.assign(layer, { commands: provideCommands(commands, { layer: activation }) })
}
