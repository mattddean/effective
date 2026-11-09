import type * as Layer from 'effect/Layer'

import { Command } from 'effect/cli'
import * as Effect from 'effect/Effect'

export type ProvidedCommandFactory<Factory, Services, Error, Requirements> =
  Factory extends Effect.Effect<infer C, infer E, infer R>
    ? C extends Command.Command<infer Name, infer Input, infer ContextInput, infer CE, infer CR>
      ? Effect.Effect<
          Command.Command<Name, Input, ContextInput, CE | Error, Exclude<CR, Services> | Requirements>,
          E,
          R
        >
      : never
    : never

/** Supplies execution dependencies while preserving each factory's command input and construction requirements. */
export function provideCommands<
  E,
  R,
  const Factories extends ReadonlyArray<Effect.Effect<Command.Command.Any, E, R>>,
  A,
  LE,
  LR,
>(
  factories: Factories,
  options: { readonly layer: Layer.Layer<A, LE, LR> },
): ReadonlyArray<ProvidedCommandFactory<Factories[number], A, LE, LR>>
export function provideCommands<Name extends string, Input, ContextInput, CE, CR, E, R, A, LE, LR>(
  factories: ReadonlyArray<Effect.Effect<Command.Command<Name, Input, ContextInput, CE, CR>, E, R>>,
  options: { readonly layer: Layer.Layer<A, LE, LR> },
): ReadonlyArray<Effect.Effect<Command.Command<Name, Input, ContextInput, CE | LE, Exclude<CR, A> | LR>, E, R>> {
  return factories.map(Effect.map(Command.provide(options.layer)))
}
