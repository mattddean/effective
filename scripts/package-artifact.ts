import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { PackageManifest } from './types.ts'

export function pack(directory: string, destination: string): string {
  mkdirSync(destination, { recursive: true })
  const path = resolve(destination, 'effective.tgz')
  execFileSync('bun', ['pm', 'pack', '--ignore-scripts', '--filename', path, '--quiet'], { cwd: directory, stdio: 'pipe' })
  return path
}

export function contents(tarball: string): { files: string[]; manifest: PackageManifest } {
  const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n').filter(path => !path.endsWith('/')).map(path => path.replace(/^package\//, ''))
  const manifest: PackageManifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  return { files, manifest }
}

export function integrity(tarball: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(pack(process.cwd(), resolve('.artifacts')))
}
