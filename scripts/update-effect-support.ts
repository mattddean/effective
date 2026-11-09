import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { addSupport, companions, companionVersion, pendingVersions, readRegistry } from './effect-policy.ts'

import type { PackageManifest } from './types.ts'

const manifest: PackageManifest = JSON.parse(readFileSync('package.json', 'utf8'))
const registry = await readRegistry('effect')
const candidate = pendingVersions(manifest, Object.keys(registry.versions))[0]
let changed = false
if (candidate) {
  // Prefer matched fixture releases, but allow compatible stable fixtures when release timing differs.
  const packages = await Promise.all(companions.map(readRegistry))
  const compatible = packages.every(pkg => {
    try { companionVersion(pkg, candidate); return true } catch { return false }
  })
  if (compatible) {
    writeFileSync('package.json', JSON.stringify(addSupport(manifest, candidate), null, 2) + '\n')
    execFileSync('bun', ['install', '--lockfile-only', '--ignore-scripts'], { stdio: 'inherit' })
    changed = true
  } else console.log(`Waiting for companion packages compatible with Effect ${candidate}`)
}
const output = `changed=${changed}\nversion=${candidate ?? ''}\n`
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
process.stdout.write(output)
