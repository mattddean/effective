export interface SupportManifest {
  peerDependencies: Record<string, string> & { effect: string }
  devDependencies: Record<string, string> & { effect: string }
  scripts?: Record<string, string>
}

export interface PackageManifest extends SupportManifest {
  name: string
  version: string
  publishConfig: { registry: string }
}

export interface RegistryMetadata {
  name: string
  versions: Record<string, { peerDependencies?: Record<string, string> }>
}
