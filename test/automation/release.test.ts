import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeCommits } from '@semantic-release/commit-analyzer'
import { parse } from 'yaml'
import { commitAnalysis } from '../../scripts/release-options.ts'
import { integrity, pack } from '../../scripts/package-artifact.ts'
import { validateArtifact } from '../../scripts/release-plugin.ts'

const root = new URL('../../', import.meta.url)

test('compatibility commits cause a patch release; ordinary maintenance does not', async () => {
  const options = commitAnalysis
  const analyze = (message: string) => analyzeCommits(options, { cwd: root.pathname, commits: [{ message }], logger: { log() {} } })
  expect(await analyze('fix(compat): support Effect 4.1.3')).toBe('patch')
  expect(await analyze('chore: update CI')).toBe(null)
})

test('release refuses a tarball changed after validation', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'effective-release-test-'))
  try {
    execFileSync('git', ['init', '-q', scratch])
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: scratch })
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: '@mtdn.dev/effective', version: '0.1.1', files: ['index.js'] }))
    writeFileSync(join(scratch, 'index.js'), 'export const value = 1\n')
    const tarball = pack(scratch, join(scratch, '.release'))
    writeFileSync(join(scratch, '.release/validated.json'), JSON.stringify({ version: '0.1.1', integrity: integrity(tarball), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).trim() }))
    expect(validateArtifact(scratch, { version: '0.1.1' }).manifest.version).toBe('0.1.1')
    writeFileSync(tarball, 'tampered')
    expect(() => validateArtifact(scratch, { version: '0.1.1' })).toThrow('changed after compatibility verification')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('CI requires the complete matrix and publishes only from a successful main push', () => {
  const ci = parse(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8'))
  expect(ci.jobs.compatibility.strategy['fail-fast']).toBe(false)
  expect(ci.jobs.compatibility['continue-on-error']).toBeUndefined()
  expect(ci.jobs.gate.needs).toEqual(['prepare', 'compatibility'])
  expect(ci.jobs.gate.if).toBe('always()')
  expect(ci.jobs.gate.steps[0].run).toContain('test "$MATRIX_RESULT" = success')
  expect(ci.jobs.release.needs).toBe('gate')
  expect(ci.jobs.release.if).toContain("github.event_name == 'push'")
  expect(ci.jobs.release.if).toContain("vars.NPM_RELEASES_ENABLED == 'true'")
  expect(ci.jobs.release.permissions['id-token']).toBe('write')
  const update = parse(readFileSync(new URL('.github/workflows/effect-updates.yml', root), 'utf8'))
  expect(update.on.schedule).toHaveLength(1)
  expect(update.jobs.propose.if).toContain("EFFECT_UPDATES_ENABLED == 'true'")
})
