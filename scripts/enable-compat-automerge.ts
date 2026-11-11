import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'

interface Protection {
  required_status_checks?: { strict: boolean; contexts?: string[]; checks?: { context: string }[] }
  enforce_admins?: { enabled: boolean }
  required_pull_request_reviews?: { bypass_pull_request_allowances?: Record<string, unknown[]> }
}

const repository = process.env.GITHUB_REPOSITORY
const branch = process.env.DEFAULT_BRANCH
const number = process.env.PR_NUMBER
assert(repository)
assert(number)
assert(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''))
assert(/^\d+$/.test(number ?? ''))
assert(branch)
const requiredChecksMessage = 'Require the Compatibility gate check and up-to-date branches before enabling unattended merges'
const base = `repos/${repository}`
const encodedBranch = encodeURIComponent(branch)

function api<T>(path: string, allowMissing = false, paginate = false): T | undefined {
  const result = spawnSync('gh', ['api', path, ...(paginate ? ['--paginate', '--slurp'] : [])], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    // Only a missing classic protection rule permits the ruleset fallback. Permission,
    // transport, and server failures must not be mistaken for an unprotected branch.
    if (allowMissing && result.status !== null && result.stdout) {
      let response: { status?: string | number } = {}
      try { response = JSON.parse(result.stdout) } catch { /* Preserve the API failure below. */ }
      if (String(response.status) === '404') return undefined
    }
    throw new Error(`Unable to inspect branch protection (${path}): ${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout)
}

const protection = api<Protection>(`${base}/branches/${encodedBranch}/protection`, true)
if (protection) {
  const checks = protection.required_status_checks
  const names = [...(checks?.contexts ?? []), ...(checks?.checks ?? []).map(check => check.context)]
  assert(checks?.strict && names.includes('Compatibility gate'), requiredChecksMessage)
  assert(protection.enforce_admins?.enabled, 'Branch protection must also apply to administrators')
  const bypass = protection.required_pull_request_reviews?.bypass_pull_request_allowances
  assert(!bypass || ['users', 'teams', 'apps'].every(key => !bypass[key]?.length), 'Do not bypass required compatibility checks for the update bot')
} else {
  interface BranchRule {
    type: string
    ruleset_id: number
    parameters?: {
      strict_required_status_checks_policy?: boolean
      required_status_checks?: { context: string }[]
    }
  }
  interface Ruleset {
    enforcement: string
    bypass_actors?: unknown[]
  }
  // This endpoint selects active rules for this branch, including inherited rulesets.
  // Slurp preserves every page when many rules apply to a branch.
  const pages = api<BranchRule[][]>(`${base}/rules/branches/${encodedBranch}`, false, true)
  const candidates = pages?.flat().filter(rule => rule.type === 'required_status_checks'
    && rule.parameters?.strict_required_status_checks_policy
    && rule.parameters.required_status_checks?.some(check => check.context === 'Compatibility gate')) ?? []
  assert(candidates.length, requiredChecksMessage)
  let protectedWithoutBypass = false
  for (const id of new Set(candidates.map(rule => rule.ruleset_id))) {
    const ruleset = api<Ruleset>(`${base}/rulesets/${id}`)
    // GitHub can omit bypass_actors when the caller cannot inspect them. Absence
    // is not proof that nobody can bypass the required check.
    if (ruleset?.enforcement === 'active' && Array.isArray(ruleset.bypass_actors) && ruleset.bypass_actors.length === 0) {
      protectedWithoutBypass = true
      break
    }
  }
  assert(protectedWithoutBypass, 'Require an active ruleset with a visible, empty bypass list; remove bypass actors and ensure the bot can inspect bypass_actors')
}
execFileSync('gh', ['pr', 'merge', number, '--repo', repository, '--auto', '--squash', '--subject', `fix(compat): support Effect ${process.env.EFFECT_VERSION}`], { stdio: 'inherit' })
