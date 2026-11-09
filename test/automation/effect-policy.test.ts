import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSupport, companionVersion, matrix, pendingVersions, supportedVersions } from '../../scripts/effect-policy.ts'

const manifest = (effect: string) => ({ peerDependencies: { effect }, devDependencies: { effect: '4.1.2' } })

test.each(['~4.1.2', '^4.1.2', '4.1', '*', '>=4.1.2', '4.1.2 || 4.1.2', '4.1.3 || 4.1.2', '4.1.2 || 4.2.0-beta.1'])('rejects support that is not a sorted exact stable set: %s', range => {
  expect(() => supportedVersions(manifest(range))).toThrow()
})

test('matrix enumerates every admitted version and rejects silently removing an old row', () => {
  const old = manifest('4.1.2 || 4.1.3')
  const next = addSupport(old, '4.2.0')
  expect(matrix(next, old)).toEqual({ version: ['4.1.2', '4.1.3', '4.2.0'] })
  expect(() => matrix(manifest('4.1.2 || 4.2.0'), old)).toThrow('Removing Effect 4.1.3')
  expect(old.peerDependencies.effect).toBe('4.1.2 || 4.1.3')
})

test('support additions are idempotent and major upgrades need a manual policy change', () => {
  const current = manifest('4.1.2')
  expect(addSupport(addSupport(current, '4.1.3'), '4.1.3').peerDependencies.effect).toBe('4.1.2 || 4.1.3')
  expect(() => addSupport(current, '5.0.0')).toThrow('Major upgrades')
  expect(() => supportedVersions(manifest('4.1.3'))).toThrow('baseline')
})

test('release discovery includes intervening stable releases, not only latest', () => {
  expect(pendingVersions(manifest('4.1.2'), [
    '4.2.0', '4.1.4', '4.1.2', '4.1.3', '4.1.1', '4.3.0-beta.1', '5.0.0', 'invalid',
  ])).toEqual(['4.1.3', '4.1.4', '4.2.0'])
})

test('initial exact-policy adoption retains the former development baseline', () => {
  const previous = manifest('~4.1.2')
  expect(matrix(manifest('4.1.0 || 4.1.1 || 4.1.2'), previous).version).toContain('4.1.2')
  expect(() => matrix(manifest('4.1.2'), { ...previous, scripts: { 'effect:matrix': 'existing policy' } })).toThrow('exact stable')
})

test('fixture selection handles staggered releases without forcing peer conflicts', () => {
  const metadata = { name: '@effect/test', versions: {
    '4.1.0': { peerDependencies: { effect: '^4.1.0' } },
    '4.1.2': { peerDependencies: { effect: '^4.1.2' } },
    '4.2.0': { peerDependencies: { effect: '^4.2.0' } },
  } }
  expect(companionVersion(metadata, '4.1.0')).toBe('4.1.0')
  expect(companionVersion(metadata, '4.1.3')).toBe('4.1.2')
  expect(() => companionVersion(metadata, '5.0.0')).toThrow('No stable')
})

test('matrix CLI emits job outputs only after the support policy validates', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'effective-matrix-test-'))
  const output = join(scratch, 'output')
  try {
    const command = [process.execPath, new URL('../../scripts/effect-policy.ts', import.meta.url).pathname, 'matrix']
    const env = { ...process.env, GITHUB_OUTPUT: output, EFFECT_BASE_SHA: '' }
    writeFileSync(output, '')
    writeFileSync(join(scratch, 'package.json'), JSON.stringify(manifest('~4.1.2')))
    expect(Bun.spawnSync(command, { cwd: scratch, env }).exitCode).not.toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('')
    writeFileSync(join(scratch, 'package.json'), JSON.stringify(manifest('4.1.2')))
    expect(Bun.spawnSync(command, { cwd: scratch, env }).exitCode).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe('matrix={"version":["4.1.2"]}\n')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
