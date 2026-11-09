import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import semver from 'semver'

import type { PackageManifest, RegistryMetadata, SupportManifest } from './types.ts'

export const companions = ['@effect/platform-bun', '@effect/sql-sqlite-bun']

export function supportedVersions(manifest: SupportManifest): string[] {
  const range = manifest.peerDependencies?.effect
  assert.equal(typeof range, 'string', 'Declare an explicit Effect peer dependency')
  const versions = range.split(' || ')
  assert(versions.length && versions.every(v => semver.valid(v) === v && !semver.prerelease(v)), 'Effect support must be exact stable versions separated by ||')
  assert.deepEqual(versions, [...new Set(versions)].sort(semver.compare), 'Effect support must be unique and sorted')
  assert(versions.includes(manifest.devDependencies.effect), 'The development baseline must be supported')
  return versions
}

export function matrix(manifest: SupportManifest, previous?: SupportManifest) {
  const versions = supportedVersions(manifest)
  if (previous) {
    // Allow the initial move from the old patch range to an exact tested list.
    const initialPolicy = !previous.scripts?.['effect:matrix'] && previous.peerDependencies.effect === `~${previous.devDependencies.effect}`
    const required = initialPolicy ? [previous.devDependencies.effect] : supportedVersions(previous)
    for (const version of required) assert(versions.includes(version), `Removing Effect ${version} requires a deliberate support-policy change`)
  }
  return { version: versions }
}

export function addSupport(manifest: SupportManifest, version: string): SupportManifest {
  assert(semver.valid(version) === version && !semver.prerelease(version), 'Candidate must be an exact stable version')
  assert.equal(semver.major(version), semver.major(manifest.devDependencies.effect), 'Major upgrades require a manual compatibility change')
  const versions = [...new Set([...supportedVersions(manifest), version])].sort(semver.compare)
  return { ...manifest, peerDependencies: { ...manifest.peerDependencies, effect: versions.join(' || ') } }
}

export function pendingVersions(manifest: SupportManifest, published: string[]): string[] {
  const supported = supportedVersions(manifest)
  const baseline = supported[0]
  return published.filter(v => semver.valid(v) === v && !semver.prerelease(v) && semver.major(v) === semver.major(baseline) && semver.gt(v, baseline) && !supported.includes(v)).sort(semver.compare)
}

export async function readRegistry(name: string): Promise<RegistryMetadata> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`${name}: registry returned ${response.status}`)
  return response.json()
}

export function companionVersion(metadata: RegistryMetadata, version: string): string {
  const compatible = Object.keys(metadata.versions).filter(candidate =>
    semver.valid(candidate) === candidate && !semver.prerelease(candidate) &&
    typeof metadata.versions[candidate].peerDependencies?.effect === 'string' &&
    semver.satisfies(version, metadata.versions[candidate].peerDependencies.effect))
  assert(compatible.length, `No stable ${metadata.name} release supports Effect ${version}`)
  const selected = compatible.includes(version) ? version : compatible.sort(semver.compare).at(-1)
  assert(selected)
  return selected
}

export function assertInstalled(directory: string, version: string, fixtures: Record<string, string>) {
  const expected = realpathSync(`${directory}/node_modules/effect/package.json`)
  for (const name of ['effect', ...companions]) {
    const pkg: { version: string; peerDependencies: { effect: string } } = JSON.parse(readFileSync(`${directory}/node_modules/${name}/package.json`, 'utf8'))
    const expectedVersion = name === 'effect' ? version : fixtures[name]
    assert.equal(pkg.version, expectedVersion, `${name}: expected ${expectedVersion}, got ${pkg.version}`)
    if (name !== 'effect') {
      assert(semver.satisfies(version, pkg.peerDependencies.effect), `${name} does not support Effect ${version}`)
      const require = createRequire(realpathSync(`${directory}/node_modules/${name}/package.json`))
      assert.equal(realpathSync(require.resolve('effect/package.json')), expected, `${name} resolves a second Effect installation`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv[2], 'matrix')
  const manifest: PackageManifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const base = process.env.EFFECT_BASE_SHA
  if (base) assert(/^[a-f0-9]{40}$/.test(base), 'Invalid base commit SHA')
  if (base) execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { stdio: 'pipe' })
  const hasManifest = base && spawnSync('git', ['cat-file', '-e', `${base}:package.json`]).status === 0
  const previous: SupportManifest | undefined = hasManifest ? JSON.parse(execFileSync('git', ['show', `${base}:package.json`], { encoding: 'utf8' })) : undefined
  const result = JSON.stringify(matrix(manifest, previous))
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${result}\n`)
  console.log(result)
}
