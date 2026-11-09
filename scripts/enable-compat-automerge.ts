import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

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
const protection: Protection = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`], { encoding: 'utf8' }))
const checks = protection.required_status_checks
const names = [...(checks?.contexts ?? []), ...(checks?.checks ?? []).map(check => check.context)]
assert(checks?.strict && names.includes('Compatibility gate'), 'Require the Compatibility gate check and up-to-date branches before enabling unattended merges')
assert(protection.enforce_admins?.enabled, 'Branch protection must also apply to administrators')
const bypass = protection.required_pull_request_reviews?.bypass_pull_request_allowances
assert(!bypass || ['users', 'teams', 'apps'].every(key => !bypass[key]?.length), 'Do not bypass required compatibility checks for the update bot')
execFileSync('gh', ['pr', 'merge', number, '--repo', repository, '--auto', '--squash', '--subject', `fix(compat): support Effect ${process.env.EFFECT_VERSION}`], { stdio: 'inherit' })
