import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const scratch = mkdtempSync(join(tmpdir(), 'effective-package-'))
const run = (command, args, cwd = scratch) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], root))
  const pack = Array.isArray(packed) ? packed[0] : packed[manifest.name]
  const paths = pack.files.map(({ path }) => path)
  for (const required of ['LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/storage.js', 'dist/storage.d.ts', 'AGENTS.md', 'ai-docs/api.md', 'skills/effective/SKILL.md']) {
    assert(paths.includes(required), `Missing packed file: ${required}`)
  }
  assert(paths.every(path => /^(dist\/|ai-docs\/|AGENTS\.md$|skills\/|package\.json$|README\.md$|LICENSE$)/.test(path)), 'Unexpected files in npm tarball')
  const skill = readFileSync(join(root, 'skills/effective/SKILL.md'), 'utf8')
  assert(/^---\nname: effective\ndescription: .+\n---\n/.test(skill), 'Invalid skill frontmatter')
  assert(skill.includes('node_modules/@mtdn.dev/effective/AGENTS.md'), 'Skill must point to the installed package guide')
  assert.deepEqual(paths.filter(path => path.startsWith('skills/')), ['skills/effective/SKILL.md'], 'Only the pointer skill should be copied into agent directories')

  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(scratch, pack.filename), `effect@${manifest.devDependencies.effect}`])
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

  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', `drizzle-orm@${manifest.devDependencies['drizzle-orm']}`])
  run('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { getTableName } from 'drizzle-orm';
    import { eventJournal, clusterMessages } from '@mtdn.dev/effective/storage';
    assert.equal(getTableName(eventJournal), 'effect_event_journal');
    assert.equal(getTableName(clusterMessages), 'cluster_messages');
  `])
  console.log(`Validated ${manifest.name}@${manifest.version}: tarball contents, standalone ESM imports, optional storage, installed-package skill guidance, and all packaged TypeScript examples.`)
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
