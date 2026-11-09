import type { Options } from 'semantic-release'

export const commitAnalysis = {
  releaseRules: [{ type: 'fix', scope: 'compat', release: 'patch' }],
}

export default {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', commitAnalysis],
    '@semantic-release/release-notes-generator',
    './scripts/release-plugin.ts',
    ['@semantic-release/github', { successComment: false, failComment: false, releasedLabels: false, failTitle: false }],
  ],
} satisfies Options
