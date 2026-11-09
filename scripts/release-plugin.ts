import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { contents, integrity, pack } from './package-artifact.ts'
import { supportedVersions } from './effect-policy.ts'

import type { PrepareContext, VerifyConditionsContext } from 'semantic-release'
import type { PackageManifest } from './types.ts'

type NextRelease = Pick<PrepareContext["nextRelease"], "version">
interface ReleaseContext { cwd?: string; nextRelease: NextRelease }
interface ValidatedArtifact { version: string; integrity: string; commit: string }

export function verifyConditions(_config: unknown, { cwd = process.cwd(), env }: Pick<VerifyConditionsContext, "cwd" | "env">) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Automated releases run in GitHub Actions')
  const tags = execFileSync('git', ['tag', '--merged', 'HEAD', '--list', 'v*'], { cwd, encoding: 'utf8' }).trim().split('\n')
  assert(tags.some(tag => semver.valid(tag.slice(1)) && !semver.prerelease(tag.slice(1))), 'Bootstrap the first npm version and matching Git tag before enabling automatic releases')
  const npm = execFileSync(join(cwd, 'node_modules/.bin/npm'), ['--version'], { cwd, encoding: 'utf8' }).trim()
  assert(semver.satisfies(npm, '>=11.5.1'), 'npm >=11.5.1 is required for trusted publishing')
}

export function prepare(_config: unknown, { cwd = process.cwd(), nextRelease }: ReleaseContext) {
  assert(semver.valid(nextRelease.version) && !semver.prerelease(nextRelease.version), 'Only stable releases are automatic')
  const path = join(cwd, 'package.json')
  const manifest: PackageManifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.version = nextRelease.version
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  execFileSync('bun', ['install', '--lockfile-only', '--ignore-scripts'], { cwd, stdio: 'inherit' })
  execFileSync('bun', ['run', 'build'], { cwd, stdio: 'inherit' })
  const tarball = pack(cwd, join(cwd, '.release'))
  // Validate the exact, final-version artifact against every allowed Effect version.
  for (const version of supportedVersions(manifest)) {
    execFileSync('bun', ['scripts/check-package.ts', '--effect', version, '--tarball', tarball], { cwd, stdio: 'inherit' })
  }
  writeFileSync(join(cwd, '.release/validated.json'), JSON.stringify({
    version: nextRelease.version,
    integrity: integrity(tarball),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(),
  }))
}

export function validateArtifact(cwd: string, nextRelease: NextRelease) {
  const tarball = join(cwd, '.release/effective.tgz')
  const validated: ValidatedArtifact = JSON.parse(readFileSync(join(cwd, '.release/validated.json'), 'utf8'))
  assert.equal(validated.version, nextRelease.version)
  assert.equal(validated.integrity, integrity(tarball), 'The tarball changed after compatibility verification')
  assert.equal(validated.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim())
  const { manifest } = contents(tarball)
  assert.equal(manifest.version, validated.version)
  return { tarball, manifest, validated }
}

export async function publish(_config: unknown, { cwd = process.cwd(), nextRelease }: ReleaseContext) {
  const { tarball, manifest, validated } = validateArtifact(cwd, nextRelease)
  const registry = manifest.publishConfig.registry.replace(/\/$/, '')
  const response = await fetch(`${registry}/${encodeURIComponent(manifest.name)}/${manifest.version}`, { signal: AbortSignal.timeout(30000) })
  if (response.ok) {
    const existing = await response.json()
    assert.equal(existing.dist.integrity, validated.integrity, 'An existing registry version has different bytes')
  } else {
    assert.equal(response.status, 404, `Registry lookup failed: ${response.status}`)
    // Bun manages installs and packing; npm is only the OIDC/provenance publisher.
    execFileSync(join(cwd, 'node_modules/.bin/npm'), ['publish', tarball, '--ignore-scripts', '--access', 'public', '--tag', 'latest'], { cwd, stdio: 'inherit' })
  }
  return { name: `npm ${manifest.name}`, url: `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}` }
}
