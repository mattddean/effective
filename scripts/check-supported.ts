import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pack } from './package-artifact.ts'
import { supportedVersions } from './effect-policy.ts'

import type { PackageManifest } from './types.ts'

const root = process.cwd()
const manifest: PackageManifest = JSON.parse(readFileSync('package.json', 'utf8'))
execFileSync('bun', ['run', 'build'], { stdio: 'inherit' })
const tarball = pack(root, `${root}/.artifacts`)
for (const version of supportedVersions(manifest)) {
  execFileSync('bun', ['scripts/check-effect-version.ts', '--effect', version, '--tarball', tarball], { stdio: 'inherit' })
}
