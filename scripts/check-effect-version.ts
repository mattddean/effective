import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { assertInstalled, companions, companionVersion, readRegistry, supportedVersions } from './effect-policy.ts'

import type { PackageManifest } from './types.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { effect: { type: 'string' }, tarball: { type: 'string' } } })
const version = values.effect
const manifest: PackageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert(version && supportedVersions(manifest).includes(version), 'Test version must be declared in peerDependencies.effect')
assert(values.tarball, 'Supply the baseline-built tarball with --tarball')
const tarball = resolve(values.tarball)
const scratch = mkdtempSync(join(tmpdir(), 'effective-source-'))
try {
  cpSync(root, scratch, { recursive: true, filter: path => !['node_modules', '.git', 'dist', '.artifacts', '.release'].includes(basename(path)) && !path.endsWith('.tgz') })
  manifest.devDependencies.effect = version
  const fixtures: Record<string, string> = {}
  for (const name of companions) {
    fixtures[name] = companionVersion(await readRegistry(name), version)
    manifest.devDependencies[name] = fixtures[name]
  }
  writeFileSync(join(scratch, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  const run = (args: string[]) => execFileSync('bun', args, { cwd: scratch, stdio: 'inherit' })
  run(['install', '--ignore-scripts'])
  assertInstalled(scratch, version, fixtures)
  run(['run', 'typecheck'])
  run(['run', 'test'])
  run(['scripts/check-package.ts', '--effect', version, '--tarball', tarball])
  console.log(`Effect ${version}: source tests and the baseline-built package passed.`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
