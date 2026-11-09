import { expect, test } from 'bun:test'
import { Command, Flag } from 'effect/cli'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { defineEvent, defineListener } from '~/framework/event.logic'
import { defineModule, defineModules } from '~/framework/module.logic'
import { withShoppingTransaction } from '~/infrastructure/transaction.operation'
import { testRuntime } from '~/test/runtime/root.runtime'

class FactoryInput extends Context.Service<FactoryInput, { readonly value: number }>()('ModuleCommands/FactoryInput') {}
class HandlerInput extends Context.Service<HandlerInput, { readonly value: number }>()('ModuleCommands/HandlerInput') {}
class PublicService extends Context.Service<PublicService, { readonly value: number }>()('ModuleCommands/Public') {}
class PrivateService extends Context.Service<PrivateService, PublicService['Service']>()('ModuleCommands/Private') {}
class ImportedService extends Context.Service<ImportedService, PublicService['Service']>()('ModuleCommands/Imported') {}
class ImportedPrivate extends Context.Service<ImportedPrivate, PublicService['Service']>()(
  'ModuleCommands/ImportedPrivate',
) {}

const commandModule = defineModule({
  imports: [],
  internal: [],
  exports: [Layer.succeed(PublicService, { value: 42 })],
  commands: [
    Effect.gen(function* () {
      const input = yield* FactoryInput
      if (input.value === 0) return yield* Effect.fail('factory-failed' as const)
      return Command.make('first', {}, () => HandlerInput.pipe(Effect.andThen(Effect.fail('handler-failed' as const))))
    }),
  ],
})
const otherModule = defineModule({
  imports: [commandModule],
  internal: [],
  exports: [],
  commands: [Effect.succeed(Command.make('second'))],
})
const emptyModule = defineModule({ imports: [], internal: [], exports: [] })
const application = defineModules([commandModule, otherModule, emptyModule])

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<Condition extends true> = Condition
type Factory = (typeof application.commands)[number]
type RegisteredCommand = Effect.Success<Factory>

export type CommandNamesArePreserved = Assert<Equal<RegisteredCommand['name'], 'first' | 'second'>>
export type FactoryRequirementsArePreserved = Assert<Equal<Effect.Services<Factory>, FactoryInput>>
export type FactoryErrorsArePreserved = Assert<Equal<Effect.Error<Factory>, 'factory-failed'>>
export type HandlerRequirementsArePreserved = Assert<Equal<Command.Services<RegisteredCommand>, HandlerInput>>
export type HandlerErrorsArePreserved = Assert<Equal<Command.Error<RegisteredCommand>, 'handler-failed'>>
export type CommandsDoNotAddLayerRequirements = Assert<Equal<Layer.Services<typeof application>, never>>
export type CommandsDoNotAddLayerErrors = Assert<Equal<Layer.Error<typeof application>, never>>
export type CommandsDoNotAddPublicServices = Assert<Equal<Layer.Success<typeof application>, PublicService>>

test('collects owned commands once, preserving order and skipping modules without commands', async () => {
  const commands = await testRuntime.runPromise(
    Effect.all(application.commands).pipe(Effect.provideService(FactoryInput, { value: 1 })),
  )
  expect(commands.map((command) => command.name)).toEqual(['first', 'second'])
})

test('application layers build without command dependencies or command factory failures', async () => {
  const service = await testRuntime.runPromise(PublicService.pipe(Effect.provide(application)))
  expect(service.value).toBe(42)

  const error = await testRuntime.runPromise(
    Effect.all(application.commands).pipe(Effect.provideService(FactoryInput, { value: 0 }), Effect.flip),
  )
  expect(error).toBe('factory-failed')
})

test('registered handlers retain their injected services and failures', async () => {
  const error = await testRuntime.runPromise(
    Effect.gen(function* () {
      const commands = yield* Effect.all(application.commands)
      const root = Command.make('test').pipe(Command.withSubcommands(commands))
      return yield* Command.runWith(root, { version: '1.0.0', renderErrors: false })(['first']).pipe(Effect.flip)
    }).pipe(Effect.provideService(FactoryInput, { value: 1 }), Effect.provideService(HandlerInput, { value: 2 })),
  )
  expect(error).toBe('handler-failed')
})

test('CLI dispatch defers fixed infrastructure until execution and acquires only the selected flag-dependent layer', async () => {
  const selected: Array<'default' | 'local'> = []
  let releases = 0
  let rootAcquisitions = 0
  let rootReleases = 0
  let moduleAcquisitions = 0
  const infrastructure = Layer.effect(
    PublicService,
    Effect.acquireRelease(
      Effect.sync(() => {
        rootAcquisitions++
        return { value: 42 }
      }),
      () =>
        Effect.sync(() => {
          rootReleases++
        }),
    ),
  )
  const worker = Command.make(
    'run',
    { worker: Flag.Literals('worker', ['default', 'local']) },
    () => HandlerInput,
  ).pipe(
    Command.provide(({ worker }) =>
      Layer.effect(
        HandlerInput,
        Effect.acquireRelease(
          Effect.sync(() => {
            selected.push(worker)
            return { value: 1 }
          }),
          () =>
            Effect.sync(() => {
              releases++
            }),
        ),
      ),
    ),
  )
  const module = defineModule({
    imports: [],
    internal: [],
    exports: [],
    listeners: [
      Layer.effectDiscard(
        Effect.sync(() => {
          moduleAcquisitions++
        }),
      ),
    ],
    commands: [
      Effect.succeed(Command.make('jobs').pipe(Command.withSubcommands([worker]))),
      Effect.succeed(
        Command.make('users', {}, () =>
          PublicService.pipe(
            Effect.tap((service) =>
              Effect.sync(() => {
                expect(service.value).toBe(42)
              }),
            ),
          ),
        ),
      ),
    ],
  })
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const commands = yield* Effect.all(defineModules([module]).commands)
      const root = Command.make('test').pipe(Command.withSubcommands(commands), Command.provide(infrastructure))
      const run = Command.runWith(root, { version: '1.0.0', renderErrors: false })
      yield* run(['--help'])
      yield* run(['jobs', 'run', '--help'])
      yield* run(['--completions', 'bash'])
      const invalid = yield* run(['jobs', 'run', '--worker', 'invalid']).pipe(Effect.flip)
      expect(invalid._tag).toBe('ShowHelp')
      expect(rootAcquisitions).toBe(0)
      expect(selected).toEqual([])
      yield* run(['users'])
      expect(rootAcquisitions).toBe(1)
      expect(selected).toEqual([])
      yield* run(['jobs', 'run', '--worker', 'local'])
      yield* run(['jobs', 'run', '--worker', 'default'])
    }),
  )
  expect(selected).toEqual(['local', 'default'])
  expect(releases).toBe(2)
  expect(rootAcquisitions).toBe(3)
  expect(rootReleases).toBe(3)
  expect(moduleAcquisitions).toBe(3)
})

const importedModule = defineModule({
  imports: [],
  internal: [Layer.succeed(ImportedPrivate, { value: 42 })],
  exports: [Layer.effect(ImportedService, ImportedPrivate)],
})
const privateModule = defineModule({
  imports: [importedModule],
  internal: [Layer.effect(PrivateService, ImportedService)],
  exports: [Layer.effect(PublicService, PrivateService)],
  commands: [
    Effect.succeed(
      Command.make(
        'owned',
        { value: Flag.Int('value') },
        Effect.fn('Test.ownedCommand')(function* ({ value }) {
          const imported = yield* ImportedService
          const internal = yield* PrivateService
          const service = yield* PublicService
          expect(imported).toBe(internal)
          expect(service).toBe(internal)
          expect(service.value).toBe(value)
          const context = yield* Effect.context<never>()
          expect(Option.isNone(Context.getOption(context, ImportedPrivate))).toBe(true)
        }),
      ),
    ),
    Effect.succeed(Command.make('shared').pipe(Command.withSharedFlags({ enabled: Flag.Boolean('enabled') }))),
  ],
})
const undeclaredModule = defineModule({
  imports: [],
  internal: [],
  exports: [],
  commands: [
    Effect.succeed(Command.make('undeclared', {}, () => Effect.all([ImportedService, PrivateService, PublicService]))),
  ],
})
const undeclaredApplication = defineModules([privateModule, undeclaredModule])
type PrivateCommands = Effect.Success<(typeof privateModule.commands)[number]>
type UndeclaredCommand = Extract<
  Effect.Success<(typeof undeclaredApplication.commands)[number]>,
  { readonly name: 'undeclared' }
>
export type ModuleProvidersSatisfyHandlers = Assert<Equal<Command.Services<PrivateCommands>, never>>
export type PrivateCommandInputs = Assert<
  Equal<
    Extract<PrivateCommands, { readonly name: 'owned' }> extends Command.Command<
      'owned',
      infer Input,
      infer _Context,
      infer _Error,
      infer _Requirements
    >
      ? Input
      : never,
    { readonly value: number }
  >
>
export type SharedCommandContext = Assert<
  Equal<Effect.Success<Extract<PrivateCommands, { readonly name: 'shared' }>>, { readonly enabled: boolean }>
>
export type UndeclaredProvidersStayRequired = Assert<
  Equal<Command.Services<UndeclaredCommand>, ImportedService | PrivateService | PublicService>
>
export type PrivateProvidersStayPrivate = Assert<Equal<Layer.Success<typeof privateModule>, PublicService>>

test('commands receive their module graph while other modules cannot see its private or unimported public providers', async () => {
  const outsider = defineModule({
    imports: [],
    internal: [],
    exports: [],
    commands: [
      Effect.succeed(
        Command.make(
          'outside',
          {},
          Effect.fn('Test.outsideCommand')(function* () {
            const context = yield* Effect.context<never>()
            expect(Option.isNone(Context.getOption(context, ImportedService))).toBe(true)
            expect(Option.isNone(Context.getOption(context, PrivateService))).toBe(true)
            expect(Option.isNone(Context.getOption(context, PublicService))).toBe(true)
          }),
        ),
      ),
    ],
  })
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const commands = yield* Effect.all(defineModules([privateModule, outsider]).commands)
      const root = Command.make('test').pipe(Command.withSubcommands(commands))
      const run = Command.runWith(root, { version: '1.0.0' })
      yield* run(['owned', '--value', '42'])
      yield* run(['outside'])
    }),
  )
})

test.each(['success', 'failure', 'interruption'] as const)(
  'shares module providers and releases them on %s',
  async (outcome) => {
    let acquisitions = 0
    let releases = 0
    await testRuntime.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const repository = Layer.effect(
          PrivateService,
          Effect.acquireRelease(
            Effect.sync(() => {
              acquisitions++
              return { value: 42 }
            }),
            () =>
              Effect.sync(() => {
                releases++
              }),
          ),
        )
        const service = Layer.effect(PublicService, PrivateService)
        const module = defineModule({
          imports: [],
          internal: [repository],
          exports: [service],
          commands: [
            Effect.succeed(
              Command.make(
                'run',
                {},
                Effect.fn('Test.resourceCommand')(function* () {
                  expect(yield* PrivateService).toBe(yield* PublicService)
                  expect(acquisitions).toBe(1)
                  expect(releases).toBe(0)
                  yield* Deferred.succeed(started, undefined)
                  if (outcome === 'failure') return yield* Effect.fail('handler-failed' as const)
                  if (outcome === 'interruption') return yield* Effect.never
                }),
              ),
            ),
          ],
        })
        const commands = yield* Effect.all(defineModules([module]).commands)
        const root = Command.make('test').pipe(Command.withSubcommands(commands))
        const execution = Command.runWith(root, { version: '1.0.0', renderErrors: false })(['run'])
        if (outcome === 'interruption') {
          const fiber = yield* execution.pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
        } else if (outcome === 'failure') {
          expect(yield* execution.pipe(Effect.flip)).toBe('handler-failed')
        } else {
          yield* execution
        }
      }),
    )
    expect(acquisitions).toBe(1)
    expect(releases).toBe(1)
  },
)

test('provider failures remain typed, release resources, and prevent handler execution', async () => {
  let releases = 0
  let executions = 0
  const module = defineModule({
    imports: [],
    internal: [
      Layer.effect(
        PrivateService,
        Effect.acquireRelease(Effect.succeed({ value: 42 }), () =>
          Effect.sync(() => {
            releases++
          }),
        ),
      ),
    ],
    exports: [
      Layer.effect(PublicService, PrivateService.pipe(Effect.andThen(Effect.fail('provider-failed' as const)))),
    ],
    commands: [
      Effect.succeed(
        Command.make('run', {}, () =>
          Effect.sync(() => {
            executions++
          }),
        ),
      ),
    ],
  })
  type ProviderErrorsArePreserved = Assert<
    Equal<Command.Error<Effect.Success<(typeof module.commands)[number]>>, 'provider-failed'>
  >
  const preservesErrors: ProviderErrorsArePreserved = true
  expect(preservesErrors).toBe(true)
  const error = await testRuntime.runPromise(
    Effect.gen(function* () {
      const commands = yield* Effect.all(defineModules([module]).commands)
      const root = Command.make('test').pipe(Command.withSubcommands(commands))
      return yield* Command.runWith(root, { version: '1.0.0', renderErrors: false })(['run']).pipe(Effect.flip)
    }),
  )
  expect(error).toBe('provider-failed')
  expect(executions).toBe(0)
  expect(releases).toBe(1)
})

test('parsed infrastructure configuration reaches module services before they are constructed', async () => {
  const module = defineModule({
    imports: [],
    internal: [],
    exports: [Layer.effect(PublicService, HandlerInput)],
    commands: [
      Effect.succeed(
        Command.make(
          'run',
          { expected: Flag.Int('expected') },
          Effect.fn('Test.configuredCommand')(function* ({ expected }) {
            expect((yield* PublicService).value).toBe(expected)
          }),
        ),
      ),
    ],
  })
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const commands = yield* Effect.all(defineModules([module]).commands)
      const root = Command.make('test').pipe(
        Command.withSharedFlags({ value: Flag.Int('value') }),
        Command.withSubcommands(commands),
        Command.provide(({ value }) => Layer.succeed(HandlerInput, { value })),
      )
      const run = Command.runWith(root, { version: '1.0.0' })
      yield* run(['run', '--value', '42', '--expected', '42'])
      yield* run(['--value', '7', 'run', '--expected', '7'])
    }),
  )
})

test('command execution activates consumer listeners once and releases their subscriptions afterwards', async () => {
  const event = defineEvent('test.command-publication', { payload: Schema.Struct({ value: Schema.Boolean }) })
  const received: boolean[] = []
  const publisher = defineModule({
    imports: [],
    internal: [],
    exports: [],
    events: [event],
    commands: [
      Effect.succeed(Command.make('publish', {}, () => event.publish({ value: true }).pipe(withShoppingTransaction))),
    ],
  })
  const consumer = defineModule({
    imports: [event.layer],
    internal: [],
    exports: [],
    listeners: [
      defineListener(event, {
        name: 'test.command-consumer',
        processing: 'transactional',
        make: Effect.succeed(
          Effect.fn('Test.commandConsumer')((payload) =>
            Effect.sync(() => {
              received.push(payload.value)
            }),
          ),
        ),
      }),
    ],
  })
  await testRuntime.runPromise(
    Effect.gen(function* () {
      const commands = yield* Effect.all(defineModules([publisher, consumer]).commands)
      const root = Command.make('test').pipe(Command.withSubcommands(commands))
      const run = Command.runWith(root, { version: '1.0.0' })
      yield* run(['publish'])
      expect(received).toEqual([true])
      yield* run(['publish'])
      expect(received).toEqual([true, true])
      yield* event.publish({ value: false }).pipe(withShoppingTransaction)
      expect(received).toEqual([true, true])
    }).pipe(Effect.provide(event.layer)),
  )
})
