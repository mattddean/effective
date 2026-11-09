import { expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import { testRuntime } from './fixtures.js'

const backend = new URL('../../', import.meta.url).pathname

const compile = Effect.fn('ModuleEventsTest.compile')(function* (source: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'effective-module-events-' })
  yield* fs.writeFileString(
    path.join(directory, 'events.types.mts'),
    `
    import { defineEvent } from '${backend}test/unit/fixtures.js'
    import { defineModule, defineModules } from '${backend}src/module.logic.js'
    import * as Schema from '${backend}node_modules/effect/dist/Schema.js'
    const PostCreated = defineEvent('posts.created', { payload: Schema.Struct({ id: Schema.String }) })
    const CommentCreated = defineEvent('comments.created', { payload: Schema.Struct({ id: Schema.String }) })
    ${source}
  `,
  )
  yield* fs.writeFileString(
    path.join(directory, 'tsconfig.json'),
    `{
    "extends": "${backend}tsconfig.json",
    "compilerOptions": {
      "noEmit": true, "rootDir": "/", "types": ["bun"],
      "typeRoots": ["${backend}node_modules/@types"]
    },
    "files": ["./events.types.mts"], "include": []
  }`,
  )
  const process = Bun.spawn(
    [
      path.join(backend, 'node_modules/.bin/tsc'),
      '--project',
      path.join(directory, 'tsconfig.json'),
      '--pretty',
      'false',
    ],
    {
      cwd: backend,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
    Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]),
  )
  return { exitCode, output: stdout + stderr }
})

test.each([
  {
    requirement: 'duplicate names within one owning module fail compilation',
    source: `defineModule({ imports: [], internal: [], exports: [], events: [PostCreated, defineEvent(PostCreated.name, { payload: PostCreated.payload })] })`,
    diagnostic: 'duplicateEventName',
  },
  {
    requirement: 'distinct owning modules cannot declare the same event name, even with identical payload schemas',
    source: `
      const first = defineModule({ imports: [], internal: [], exports: [], events: [PostCreated] })
      const second = defineModule({ imports: [], internal: [], exports: [], events: [defineEvent(PostCreated.name, { payload: PostCreated.payload })] })
      defineModules([first, second])
    `,
    diagnostic: 'duplicateEventName',
  },
  {
    requirement: 'widened event arrays cannot bypass compile-time uniqueness',
    source: `
      const events: ReadonlyArray<typeof PostCreated> = [PostCreated]
      defineModule({ imports: [], internal: [], exports: [], events })
    `,
    diagnostic: 'eventNamesRequireATuple',
  },
])(
  'Effective product requirement: $requirement',
  async ({ source, diagnostic }) => {
    const result = await testRuntime.runPromise(compile(source).pipe(Effect.scoped))
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain(diagnostic)
  },
  15_000,
)

test('Effective product requirement: unique owning events and repeated consumer imports compile', async () => {
  const result = await testRuntime.runPromise(
    compile(`
    const publisher = defineModule({ imports: [], internal: [], exports: [], events: [PostCreated, CommentCreated] })
    const first = defineModule({ imports: [PostCreated.layer], internal: [], exports: [] })
    const second = defineModule({ imports: [PostCreated.layer], internal: [], exports: [] })
    defineModules([publisher, first, second])
  `).pipe(Effect.scoped),
  )
  expect(result.output).not.toContain('error TS')
  expect(result.exitCode).toBe(0)
}, 15_000)
