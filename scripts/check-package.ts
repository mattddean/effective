import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { contents, pack } from './package-artifact.ts'
import { supportedVersions } from './effect-policy.ts'

import type { PackageManifest } from './types.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest: PackageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const { values } = parseArgs({ options: { effect: { type: 'string' }, tarball: { type: 'string' } } })
const effectVersion = values.effect ?? manifest.devDependencies.effect
assert(supportedVersions(manifest).includes(effectVersion), 'Selected Effect version is not supported')
const scratch = mkdtempSync(join(tmpdir(), 'effective-package-'))
const run = (command: string, args: string[], cwd = scratch) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

try {
  const tarball = values.tarball ? resolve(values.tarball) : pack(root, scratch)
  const { files: paths, manifest: packedManifest } = contents(tarball)
  assert.equal(packedManifest.peerDependencies.effect, manifest.peerDependencies.effect)
  for (const required of ['LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/storage/drizzle.js', 'dist/storage/drizzle.d.ts', 'AGENTS.md', 'ai-docs/api.md', 'skills/effective/SKILL.md']) {
    assert(paths.includes(required), `Missing packed file: ${required}`)
  }
  assert(paths.every(path => /^(dist\/|ai-docs\/|AGENTS\.md$|skills\/|package\.json$|README\.md$|LICENSE$)/.test(path)), 'Unexpected files in npm tarball')
  const skill = readFileSync(join(root, 'skills/effective/SKILL.md'), 'utf8')
  assert(/^---\nname: effective\ndescription: .+\n---\n/.test(skill), 'Invalid skill frontmatter')
  assert(skill.includes('node_modules/@mtdn.dev/effective/AGENTS.md'), 'Skill must point to the installed package guide')
  assert.deepEqual(paths.filter(path => path.startsWith('skills/')), ['skills/effective/SKILL.md'], 'Only the pointer skill should be copied into agent directories')

  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@mtdn.dev/effective': `file:${tarball}`, effect: effectVersion } }))
  run('bun', ['install', '--ignore-scripts'])
  assert.equal(JSON.parse(readFileSync(join(scratch, 'node_modules/effect/package.json'), 'utf8')).version, effectVersion)
  run('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { defineModule, defineModules, defineServiceLayer, createEventSystem, EventJournalLive } from '@mtdn.dev/effective';
    for (const api of [defineModule, defineModules, defineServiceLayer, createEventSystem]) assert.equal(typeof api, 'function');
    assert.ok(EventJournalLive);
    await assert.rejects(import('drizzle-orm'), { code: 'ERR_MODULE_NOT_FOUND' });
    const module = defineModule({ imports: [], internal: [], exports: [] });
    assert.equal(defineModules([module]).commands.length, 0);
  `])

  // Install the skill independently of the package, as the skills CLI does.
  const skillDirectory = join(scratch, '.agents/skills/effective')
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(join(skillDirectory, 'SKILL.md'), skill)
  const installedPackage = join(scratch, 'node_modules/@mtdn.dev/effective')
  const requireFromPackage = createRequire(realpathSync(join(installedPackage, 'package.json')))
  assert.equal(JSON.parse(readFileSync(requireFromPackage.resolve('effect/package.json'), 'utf8')).version, effectVersion)
  const installedInstructions = readFileSync(join(installedPackage, 'AGENTS.md'), 'utf8')
  assert.equal(installedInstructions, readFileSync(join(root, 'AGENTS.md'), 'utf8'))
  for (const [, path] of installedInstructions.matchAll(/\]\((\.\/[^)]+)\)/g)) {
    assert(readFileSync(resolve(installedPackage, path), 'utf8').length > 0, `Missing installed guide reference: ${path}`)
  }
  const guide = readFileSync(join(installedPackage, 'ai-docs/api.md'), 'utf8')
  const examples = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)].map(([, source]) => source)
  assert.equal(examples.length, 3)
  for (const [index, filename] of ['service.ts', 'events.ts', 'listener.ts'].entries()) {
    writeFileSync(join(scratch, filename), examples[index])
  }
  run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'service.ts', 'events.ts', 'listener.ts'])

  run('bun', ['add', '--ignore-scripts', '--exact', `drizzle-orm@${manifest.devDependencies['drizzle-orm']}`])
  run('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { getTableName } from 'drizzle-orm';
    import { eventJournal, clusterMessages } from '@mtdn.dev/effective/storage/drizzle';
    assert.equal(getTableName(eventJournal), 'effect_event_journal');
    assert.equal(getTableName(clusterMessages), 'cluster_messages');
  `])
  writeFileSync(join(scratch, 'storage.ts'), `
    import { clusterMessages } from '@mtdn.dev/effective/storage/drizzle';
    export const messages = clusterMessages;
  `)
  run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'storage.ts'])
  const bundled = await Bun.build({ entrypoints: [join(scratch, 'storage.ts')], target: 'browser', minify: true })
  assert(bundled.success, 'Drizzle schema consumer must bundle')
  const bundle = await bundled.outputs[0].text()
  assert(bundle.includes('cluster_messages'), 'Selected table must survive tree shaking')
  for (const unused of ['cluster_replies', 'cluster_runners', 'effect_event_journal']) {
    assert(!bundle.includes(unused), `Unused table survived tree shaking: ${unused}`)
  }
  console.log(`Validated ${manifest.name}@${packedManifest.version} with Effect ${effectVersion}: tarball contents, standalone ESM imports, optional tree-shaken Drizzle storage, installed-package skill guidance, and all packaged TypeScript examples.`)
} catch (error) {
  if (error instanceof Error) {
    for (const stream of ["stdout", "stderr"]) {
      const output: unknown = Reflect.get(error, stream)
      if (typeof output === "string" || output instanceof Uint8Array) process.stderr.write(output)
    }
  }
  throw error
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
