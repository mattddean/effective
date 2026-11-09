# Publishing research: `@mtdn.dev/effective`

Researched 2026-11-08 against official documentation and first-party repositories. These findings informed the package configuration; see [publishing.md](./publishing.md) for the implemented release process. npm scope ownership, package availability, repository visibility, and account settings were not verified.

## Publishing, bootstrap, and versions

- **Scope:** npm scopes belong to npm users or organizations. Confirm publish rights to the exact `mtdn.dev` namespace; owning the similarly named DNS domain does not establish npm ownership (inference from npm's account-based scope model). [npm scopes](https://docs.npmjs.com/about-scopes/)
- **Public access:** use package name `@mtdn.dev/effective` and `npm publish --access public`. Scoped public publishing requires an npm account and, for an organization scope, an npm organization. An interactive direct publish requires account 2FA; npm also documents granular tokens with bypass 2FA as an alternative. Prefer interactive authentication for bootstrap. [Scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- **Manifest recommendation:** set `publishConfig: { "access": "public", "registry": "https://registry.npmjs.org/" }`, a real version, license, repository URL, exports/types, and a `files` allowlist including intended builds and agent documentation. Do not set `private: true`. npm supports publish-time access/registry settings and controls tarball contents through `files`; inspect the actual output. [package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- **First release:** trust configuration requires an existing registry package, package write access, and account 2FA. Therefore a brand-new name needs bootstrap before OIDC configuration; do not promise an OIDC-only first-ever publish. The documented CLI `npm trust` needs npm 11.15.0+, accepts provider-specific configuration, and requires permission flags such as `--allow-publish`. [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- **Simple bootstrap recommendation:** after validation, an authorized maintainer runs `npm login` and `npm publish --access public` locally for the first real version, then configures trust. A local publish does not provide CI build provenance; subsequent versions should come from CI. Alternative: authenticated `npm stage publish --access public` creates a new package with a public `0.0.0-stage` placeholder, withholds the staged contents, and requires maintainer approval before the real version becomes available. Staging requires npm 11.15.0+ and Node 22.14.0+. [Staged publishing](https://docs.npmjs.com/staged-publishing/)
- **Versions are immutable:** a published name/version cannot be reused, even after unpublishing. Run `npm pack --dry-run`, inspect a real tarball, and smoke-test installation before release. Use a distinct version for each attempt that reached publication. [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
- **Package version recommendation:** choose `0.1.0` while the contract is evolving; adopt `1.0.0` when stable. Use explicit prerelease versions and a non-`latest` dist-tag for previews. Follow patch/minor/major compatibility semantics rather than treating every release as a patch. [Semantic versioning](https://docs.npmjs.com/about-semantic-versioning/), [npm publish tags](https://docs.npmjs.com/cli/v11/commands/npm-publish/#tag)

### Toolchain requirements

| Feature | Official minimum / constraint |
| --- | --- |
| OIDC trusted publishing | npm 11.5.1+, Node 22.14.0+ |
| `npm trust` CLI | npm 11.15.0+ |
| Staged publishing | npm 11.15.0+, Node 22.14.0+ |
| OIDC `npm dist-tag` | npm 11.21.0+ on v11, or 12.2.0+ on v12; separate publisher permission |

Sources: [Trusted publishing](https://docs.npmjs.com/trusted-publishers/), [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/), [Staging](https://docs.npmjs.com/staged-publishing/), [Provenance](https://docs.npmjs.com/generating-provenance-statements/). Recommendation: use Node 24 for release CI, install and pin a reviewed compatible npm version explicitly, and log both versions. These are feature minima, not a claim about the latest available npm release or Effective's runtime support.

## OIDC and provenance

Configure npm's trusted publisher for GitHub owner `mattddean`, repository `effective`, workflow filename (for example `publish.yml`, without its directory), and the exact environment if used. Only supported cloud runners qualify; self-hosted runners do not. New configurations default to staging permission; explicitly allow direct publishing if using `npm publish`. Complete the first successful trusted publish within two days or recreate the expired configuration. Once verified, disallow traditional tokens and revoke obsolete credentials. OIDC does not authenticate private dependency installation, and `npm whoami` is not an OIDC authorization test. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

Provenance and publishing authorization are distinct. GitHub/GitLab trusted publishing automatically attaches provenance when both repository and package are public; `--provenance` is unnecessary. CircleCI trusted publishing does not generate it. `repository.url` must match the publishing repository exactly, including case. Provenance links an artifact to source/build identity; it does not certify safe code. A manual bootstrap cannot retroactively gain provenance. [Trusted publishing](https://docs.npmjs.com/trusted-publishers/), [Provenance requirements and limitations](https://docs.npmjs.com/generating-provenance-statements/)

## Recommended CI design

Use separate validation and release workflows. Release only from a deliberate version tag or published GitHub release. Protect release refs and optionally use a GitHub environment whose name matches npm's configuration. Recommended steps:

1. Check out the release commit; verify tag/version agreement.
2. Set up Node 24 and a pinned compatible npm; disable package-manager caching in the release job.
3. Run `npm ci` from a committed lockfile, build, type-check, and test.
4. Inspect `npm pack --dry-run` and smoke-test the package tarball in a temporary consumer, including public exports, declarations, and shipped agent files.
5. Publish with `npm publish --access public`, using job permissions `contents: read` and `id-token: write`, without an npm publishing token. If review before registry publication is desired, use `npm stage publish --access public` instead and have a maintainer approve interactively.
6. Verify the published version, public access, and provenance on npm. Do not attempt to overwrite an existing version.

This sequence adds project-specific checks to the official [setup-node OIDC example](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#publishing-to-npm-with-trusted-publisher-oidc). Pin Actions to reviewed commit SHAs when implementing the workflow. Staging approval is a separate human action; CI OIDC does not approve its own staged release. [npm stage](https://docs.npmjs.com/cli/v11/commands/npm-stage/)

## Agent documentation in installed dependencies

**Installing an npm dependency places files on disk. It does not universally register instructions or skills with an agent.** Automatic discovery, skill activation after discovery, explicit installation, and a request to read a file are separate operations.

| Client / mechanism | Documented discovery | Implication for Effective |
| --- | --- | --- |
| Codex `AGENTS.md` | Global guidance plus one instruction file per directory from project root to current directory; override/fallback rules apply. | An arbitrary dependency's `node_modules/@mtdn.dev/effective/AGENTS.md` is outside the normal startup ancestor chain. Do not advertise automatic dependency-wide loading. A consumer can explicitly instruct Codex to read it. |
| Codex skills | Repo `.agents/skills` directories from current directory to Git root; user `~/.agents/skills`, admin/system locations; symlinked skill folders supported. | Install/link a packaged skill into a recognized location before relying on metadata discovery. Shipping `skills/effective/SKILL.md` alone does not register it. |
| Claude Code instructions | Current docs support `AGENTS.md` directly from v2.1.277+, by default only when no ancestor/current `CLAUDE.md` or `CLAUDE.local.md` takes precedence. Nested instructions load when files there are read. Settings and plugin availability matter. | Do not claim Claude never supports `AGENTS.md`, or that all dependencies load at session startup. A consumer `CLAUDE.md` can explicitly import `@node_modules/@mtdn.dev/effective/AGENTS.md`; prose asking Claude to read it is model-directed, not an import. |
| Claude Code skills | Local project/user `.claude/skills`, plugins, and other documented scopes; local skill-folder symlinks supported. Cloud/account discovery differs. | Explicitly install/link into `.claude/skills` for local Claude Code. Do not assume `.agents/skills` alone or an npm dependency is enough. |
| Agent Skills standard | Defines skill contents and progressive disclosure; does not mandate installation directories. Integration guidance recommends avoiding `node_modules` in general scans. | A valid `SKILL.md` is portable content, not proof of universal runtime discovery. |

Official sources by row: [Codex instructions](https://developers.openai.com/codex/guides/agents-md), [Codex skills](https://developers.openai.com/codex/skills), [Claude memory/instructions](https://code.claude.com/docs/en/memory#agentsmd), [Claude skills](https://code.claude.com/docs/en/skills#choose-where-skills-load), [Agent Skills integration](https://agentskills.io/client-implementation/adding-skills-support).

### skills CLI: explicit dependency integration

The first-party Vercel `skills` CLI now documents `experimental_sync` (with `sync` as a compatibility alias for skills 1.7.3). It scans declared installed dependencies for root `SKILL.md`, `skills/<name>/SKILL.md`, or `dist/skills/<name>/SKILL.md` and links into `.agents/skills` and selected agent directories. Selecting Claude also links into `.claude/skills`. Example consumer opt-in, after installing Effective and a reviewed/pinned skills CLI:

```sh
npx skills experimental_sync -a codex -a claude-code -y
```

Alternatively, `skills add` accepts a local directory, so a consumer can explicitly install from `./node_modules/@mtdn.dev/effective`. The CLI can be wired into a consumer's own lifecycle script, but that is explicit setup, not inherent npm or agent behavior. Copy installs require resync after updates; symlink installs track the dependency's files. Treat the experimental command and mutable upstream docs as version-specific; verify against the pinned CLI before promising support. [skills CLI commands](https://github.com/vercel-labs/skills/blob/main/docs/commands.md)

**Implemented distribution:** follow [Effect's pointer skill](https://github.com/Effect-TS/skills/blob/main/skills/effect-ts/SKILL.md). Keep the installable skill small and direct it to `node_modules/@mtdn.dev/effective/AGENTS.md`. Ship the full guidance and linked `ai-docs/` with the npm package so they track the installed version. Consumers explicitly install the pointer from this repository or their npm dependency; updating the dependency updates the referenced guidance. Avoid a dependency `postinstall` that silently rewrites consumer agent configuration. Verify the installed guide and all its linked files in the tarball.
