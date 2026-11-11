// commit-analyzer does not ship declarations. Describe the API exercised by our release tests.
declare module '@semantic-release/commit-analyzer' {
  export interface AnalyzerOptions {
    preset?: string
    releaseRules?: readonly { type?: string; scope?: string; release: string | false }[]
  }
  export function analyzeCommits(options: AnalyzerOptions, context: {
    cwd: string
    commits: readonly { message: string }[]
    logger: { log(...values: unknown[]): void }
  }): Promise<'major' | 'minor' | 'patch' | null>
}

// release-notes-generator does not ship declarations. Describe the API exercised here.
declare module '@semantic-release/release-notes-generator' {
  export function generateNotes(options: unknown, context: {
    cwd: string
    commits: readonly { message: string; hash: string }[]
    lastRelease: { gitTag: string }
    nextRelease: { version: string; gitTag: string }
    options: { repositoryUrl: string }
  }): Promise<string>
}
