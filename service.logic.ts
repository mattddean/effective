import type * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import * as Layer from 'effect/Layer'

type SelfContainedMethods<Shape> = {
  [Method in keyof Shape]: Shape[Method] extends (...args: infer Args) => Effect.Effect<infer A, infer E, infer _R>
    ? (...args: Args) => Effect.Effect<A, E>
    : Shape[Method]
}

/**
 * Builds an application-service layer whose Effect methods have no unresolved service requirements.
 *
 * A leaked requirement, such as ShoppingTransaction from event publication, is reported at the service's `make`
 * declaration instead of propagating to an HTTP or runtime boundary. NoInfer keeps the declared service shape from
 * widening to accommodate the leak. Method arguments, results, errors, and value properties remain inferred;
 * construction dependencies and errors remain on the returned layer.
 *
 * Use Layer.effect directly for repositories, whose methods intentionally retain their database requirements.
 */
export function defineServiceLayer<Identifier, Shape, E, R>(
  service: Context.Key<Identifier, Shape>,
  options: { readonly make: Effect.Effect<NoInfer<Shape> & SelfContainedMethods<NoInfer<Shape>>, E, R> },
): Layer.Layer<Identifier, E, Exclude<R, Scope.Scope>> {
  return Layer.effect(service, options.make)
}
