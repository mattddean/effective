import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repository = 'repos/fixture/repo'
const protectionPath = `${repository}/branches/main/protection`
const rulesPath = `${repository}/rules/branches/main`
const rulesetPath = `${repository}/rulesets/42`
const missing = { status: '404', message: 'Branch not protected' }
const rule = {
  type: 'required_status_checks', ruleset_id: 42,
  parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'Compatibility gate' }] },
}
const ruleset = { enforcement: 'active', bypass_actors: [] }
const classic = {
  required_status_checks: { strict: true, contexts: ['Compatibility gate'] },
  enforce_admins: { enabled: true },
}

function run(responses: Record<string, unknown>) {
  const scratch = mkdtempSync(join(tmpdir(), 'effective-automerge-'))
  try {
    writeFileSync(join(scratch, 'responses.json'), JSON.stringify(responses))
    writeFileSync(join(scratch, 'gh'), `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n')
if (args[0] !== 'api') process.exit(0)
const responses = JSON.parse(readFileSync(process.env.RESPONSES, 'utf8'))
const response = responses[args[1]]
if (response === undefined) { console.error('Unexpected API request: ' + args[1]); process.exit(1) }
console.log(JSON.stringify(args.includes('--slurp') && Array.isArray(response) ? response.map(item => [item]) : response))
if (response.status) process.exit(1)
`, { mode: 0o755 })
    const result = Bun.spawnSync([process.execPath, new URL('../../scripts/enable-compat-automerge.ts', import.meta.url).pathname], {
      env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, RESPONSES: join(scratch, 'responses.json'), CALLS: join(scratch, 'calls'),
        GITHUB_REPOSITORY: 'fixture/repo', DEFAULT_BRANCH: 'main', PR_NUMBER: '7', EFFECT_VERSION: '4.1.3' },
    })
    return { status: result.exitCode, error: result.stderr.toString(), calls: readFileSync(join(scratch, 'calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

function expectRefusal(responses: Record<string, unknown>, message: string) {
  const result = run(responses)
  expect(result.status).not.toBe(0)
  expect(result.error).toContain(message)
  expect(result.calls.some(args => args[0] === 'pr')).toBe(false)
}

const protectedByRuleset = { [protectionPath]: missing, [rulesPath]: [rule], [rulesetPath]: ruleset }

test('ruleset-only protection enables automerge after classic protection returns 404', () => {
  const result = run(protectedByRuleset)
  expect(result.status).toBe(0)
  expect(result.calls.at(-1)).toEqual(['pr', 'merge', '7', '--repo', 'fixture/repo', '--auto', '--squash', '--subject', 'fix(compat): support Effect 4.1.3'])
})

test('classic protection still enables automerge', () => {
  expect(run({ [protectionPath]: classic }).status).toBe(0)
})

test.each([
  ['missing gate', { ...rule, parameters: { ...rule.parameters, required_status_checks: [{ context: 'Other check' }] } }],
  ['branches not up to date', { ...rule, parameters: { ...rule.parameters, strict_required_status_checks_policy: false } }],
])('rulesets refuse %s', (_, invalidRule) => {
  expectRefusal({ ...protectedByRuleset, [rulesPath]: [invalidRule] }, 'Compatibility gate check and up-to-date branches')
})

test.each([
  ['bypass actors', { ...ruleset, bypass_actors: [{ actor_type: 'Integration', actor_id: 1 }] }],
  ['hidden bypass actors', { enforcement: 'active' }],
  ['inactive ruleset', { ...ruleset, enforcement: 'disabled' }],
])('rulesets refuse %s', (_, invalidRuleset) => {
  expectRefusal({ ...protectedByRuleset, [rulesetPath]: invalidRuleset }, 'active ruleset with a visible, empty bypass list')
})

test('unprotected branches fail with an actionable message', () => {
  expectRefusal({ [protectionPath]: missing, [rulesPath]: [] }, 'Compatibility gate check and up-to-date branches')
})

test('API permission errors do not fall back to rulesets', () => {
  expectRefusal({ [protectionPath]: { status: '403', message: 'Resource not accessible by integration' } }, 'Resource not accessible by integration')
})

test('classic protection refuses admin and review bypasses', () => {
  expectRefusal({ [protectionPath]: { ...classic, enforce_admins: { enabled: false } } }, 'administrators')
  expectRefusal({ [protectionPath]: { ...classic, required_pull_request_reviews: { bypass_pull_request_allowances: { apps: [{}] } } } }, 'Do not bypass')
})


test('all pages are checked and unrelated ruleset bypasses do not weaken the qualifying rule', () => {
  const result = run({ ...protectedByRuleset, [rulesPath]: [
    { type: 'deletion', ruleset_id: 99 },
    { ...rule, ruleset_id: 43 },
    rule,
  ], [`${repository}/rulesets/43`]: { ...ruleset, bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5 }] } })
  expect(result.status).toBe(0)
  expect(result.calls).toContainEqual(['api', rulesPath, '--paginate', '--slurp'])
})

test('ruleset lookup failures prevent automerge', () => {
  expectRefusal({ ...protectedByRuleset, [rulesetPath]: { status: '403', message: 'Forbidden' } }, 'Forbidden')
})

test('classic protection recognizes check objects as well as context strings', () => {
  expect(run({ [protectionPath]: { ...classic, required_status_checks: { strict: true, checks: [{ context: 'Compatibility gate' }] } } }).status).toBe(0)
})
