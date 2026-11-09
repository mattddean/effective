// commit-analyzer does not ship declarations. Describe the API exercised by our release tests.
declare module '@semantic-release/commit-analyzer' {
  export interface AnalyzerOptions {
    releaseRules?: readonly { type?: string; scope?: string; release: string | false }[]
  }
  export function analyzeCommits(options: AnalyzerOptions, context: {
    cwd: string
    commits: readonly { message: string }[]
    logger: { log(...values: unknown[]): void }
  }): Promise<'major' | 'minor' | 'patch' | null>
}
