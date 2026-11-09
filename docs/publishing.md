# Publishing Effective and its skill

Bun 1.4.4 manages dependencies, the committed `bun.lock`, scripts, tests, and package
packing. TypeScript helpers and semantic-release run with Bun. tsdown builds ESM JavaScript
and declarations. Node 24 checks that consumers can use the built ESM package without Bun. The final registry upload
uses the Bun-installed, pinned npm 11.21.2 CLI for OIDC trusted publishing and provenance; Bun's publisher cannot currently
generate provenance. No npm lockfile or npm dependency-install workflow is used.

The npm package includes `dist/`, `AGENTS.md`, `ai-docs/`, and the small pointer skill at
`skills/effective/SKILL.md`. The skill follows [Effect's setup pattern](https://github.com/Effect-TS/skills/blob/main/skills/effect-ts/SKILL.md):
it updates the consumer's `AGENTS.md` or `CLAUDE.md` with a persistent instruction to read
`node_modules/@mtdn.dev/effective/AGENTS.md`. Detailed guidance tracks the npm dependency;
it is not copied into the installed skill. The library and skill are MIT licensed.

## Exact Effect support

`package.json`'s `peerDependencies.effect` is the single source of truth. It contains a
sorted, unique disjunction of exact stable versions, not a caret or tilde range. Development
stays pinned to a supported baseline. CI rejects invalid policies and removal of an existing
supported version. Deliberately dropping support needs a separate policy/versioning change.

For each listed version, `scripts/check-effect-version.ts` makes a disposable source checkout,
installs that exact Effect release and compatible `@effect/platform-bun`/`@effect/sql-sqlite-bun`
fixtures, verifies actual resolution, type-checks, and runs all tests. Matching fixture versions
are preferred; if a companion has not released that version, the newest stable release whose
Effect peer range accepts it is selected. No peer conflicts are suppressed. It then installs the same
baseline-built tarball in a clean consumer with the selected Effect version, checking exports,
declarations, examples, optional Drizzle storage, and installed skill guidance. The repository's
manifest, lockfile, and development installation remain unchanged by matrix testing.

Run locally:

```sh
bun install --frozen-lockfile
bun run check
bun run check:supported

# Inspect the generated matrix, or run one version against the packed artifact:
bun run effect:matrix
bun run effect:check --effect 4.1.2 --tarball .artifacts/effective.tgz
```

Current runtime coverage includes real SQLite transactions, not PostgreSQL deployments or
persistent worker restart recovery. Tests establish these covered contracts, not all possible
Effect behavior or every possible version of companion packages.

## New Effect releases

The `effect-updates.yml` workflow polls the npm registry every three hours at minute 17 (UTC) and supports
manual dispatch. GitHub schedules can be delayed; this is polling, not a direct npm publish
webhook. It enumerates stable releases rather than only reading the `latest` tag, and proposes
the oldest not-yet-supported release in the current major. It verifies that compatible stable companion releases exist.

A single `automation/effect-support` branch proposes the additive peer change and updated
Bun lockfile. Its commit/PR title is `fix(compat): support Effect <version>`. The package's
published metadata is unchanged while the PR is pending. The same PR is reused on subsequent
runs; a failing candidate blocks automatic advancement until fixed. Prereleases and new majors
are excluded from unattended admission.

CI on PRs, merge queues, and main pushes tests the entire support list. `Compatibility gate`
fails if preparation or any matrix row fails, is cancelled, or is skipped. The updater enables
squash automerge only after verifying strict branch protection with that required check and
no configured review bypass. Automerge still waits for all repository-required checks/reviews.

This uses a small scheduled updater instead of Renovate's standard range widening, which does
not preserve an append-only list of exact tested versions without custom upgrade hooks.

## Releases

`scripts/release.ts` loads `scripts/release-options.ts` directly with Bun and passes the options
to the semantic-release API. This supports TypeScript 7 without relying on the config loader’s
removed TypeScript compiler APIs.

After a successful main-branch compatibility gate, semantic-release analyzes Conventional
Commits. `fix(compat)` produces a patch; normal `fix`/`feat`/breaking-change semantics apply to
other changes. Non-release maintenance commits produce no npm release. Squash merges must
preserve the release-worthy PR title. Avoid manual version bumps for automatic releases.

The release plugin writes the next package version in its isolated runner, builds with Bun,
packs one final tarball, and tests that final artifact against every supported Effect version.
It records its SHA-512 integrity and checks it again immediately before upload. npm publishes
that exact tarball with lifecycle scripts disabled, so nothing rebuilds between validation and
publication. A registry version with different bytes is an error; published versions are immutable.
semantic-release creates the Git tag and GitHub release. Version edits are not committed back to
main; release versions come from Git tags and commits.

Release jobs serialize. npm publication and GitHub tags/releases are not an atomic operation:
if a run fails after tagging or publishing, inspect both npm and GitHub before recovery. Do not
remove/reuse published npm versions. Reconcile partial releases before restarting automation.

## Account setup and activation

The workflows are committed as configuration; no package has been published and no account
settings have been changed by adding them. Two repository variables opt into external actions.

1. **Bootstrap npm.** Confirm publish rights to `@mtdn.dev` and account 2FA. Run all checks and
   matrix rows. Authenticate the npm CLI with `npm login` and publish a reviewed first artifact
   with `npm publish .artifacts/effective.tgz --access public --ignore-scripts`. Create its matching
   `v0.1.0` Git tag at the published source commit. Automatic releases refuse to start without a
   stable bootstrap tag. Domain ownership does not grant npm namespace ownership.
2. **GitHub App for update PRs.** Install an App restricted to this repository with Contents:
   read/write, Pull requests: read/write, and Administration: read. Save its App ID in repository
   variable `EFFECT_BOT_APP_ID` and its private key in Actions secret `EFFECT_BOT_PRIVATE_KEY`.
   The App token lets update PRs trigger CI without GitHub's built-in-token recursion restrictions.
3. **Branch protection.** Require PRs, the `Compatibility gate` status check, and branches to be
   up to date on `main`. Apply protection to administrators and avoid bypass allowances. Enable
   squash merging and repository auto-merge. Required human reviews intentionally prevent fully
   unattended merges. The automerge helper currently checks classic branch protection; a ruleset-only
   repository needs an equivalent helper adjustment before enabling unattended merging.
4. **Trusted npm publishing.** Configure the package's trusted publisher for owner `mattddean`,
   repository `effective`, workflow **`ci.yml`**, environment **`npm`**, and direct publish permission.
   This replaces the old tag-driven workflow filename. Create the matching GitHub environment.
   Avoid mandatory environment approval if publishing should be unattended. Verify npm's activation
   window when creating trust. The workflow grants `id-token: write`; no npm publishing token is used.
5. **Activate.** Set `EFFECT_UPDATES_ENABLED=true` to enable candidate PRs and
   `NPM_RELEASES_ENABLED=true` to enable publishing after successful main checks. Either can remain
   disabled independently. Schedules run from the default branch, so push/merge the workflows first.
   Use manual dispatch of `Effect support updates` to check discovery without waiting for the schedule.

## Skill installation

```sh
bun add @mtdn.dev/effective effect@4.1.2
bunx skills@1.7.3 add mattddean/effective
```

Or install the pointer from the npm dependency:

```sh
bunx skills@1.7.3 add ./node_modules/@mtdn.dev/effective
```

The CLI selects agent installation locations; invoking the skill adds the persistent guide
pointer to the consumer's agent instructions. Updating the npm dependency updates the detailed
guidance without reinstalling the pointer. No separate skill repository or registry submission
is required.

Sources: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[Bun publishing and provenance](https://bun.com/docs/pm/cli/publish),
[semantic-release CI requirements](https://semantic-release.org/usage/ci-configuration/),
[GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[skills CLI](https://github.com/vercel-labs/skills/blob/main/docs/commands.md).
