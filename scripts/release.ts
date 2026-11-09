import { parseArgs } from 'node:util'
import semanticRelease from 'semantic-release'
import options from './release-options.ts'

// Load TypeScript through Bun, bypassing cosmiconfig's legacy TypeScript compiler API.
const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' } } })
await semanticRelease({ ...options, dryRun: values['dry-run'] })
