# Vite's own npm packaging and publishing

Checked **2026-11-09** against official repositories and first-party documentation. Vite `main` resolved through GitHub's API to **`5def936009d2637a48d056e197aebc6242ac27c6`**, committed **2026-11-09 10:20:57 UTC**, subject `release: v8.3.7 (#24040)`. Its package manifest says `8.3.7`. Source links below pin that revision; live documentation was checked on the research date. This establishes source configuration, not proof that a particular npm publication or workflow run succeeded. [Checked commit](https://github.com/vitejs/vite/commit/5def936009d2637a48d056e197aebc6242ac27c6)

**Finding:** Vite builds its own package directly with **Rolldown**, using separate JavaScript and declaration configurations. It does **not** build itself with `vite build --lib` or tsdown. The latter is a separate library-oriented tool built on Rolldown. [Vite build scripts](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/packages/vite/package.json), [tsdown introduction](https://tsdown.dev/guide/)

## Package contract and build commands

The `vite` manifest declares `type: "module"`, with root export `./dist/node/index.js`, plus `./module-runner` and `./internal` pointing to corresponding Node bundles. `./client` is a types-only export to `client.d.ts`; client runtime files are exposed through `./dist/client/*`. It also exports `./types/*` and `./package.json`, while blocking `./types/internal/*`. There is no separate CommonJS root build or top-level `main`, `module`, or `types` field. Its `files` allowlist includes `bin`, `dist`, `misc/**/*.js`, `client.d.ts`, and `types`. The runtime floor is Node `^20.19.0 || >=22.12.0`. [Manifest](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/packages/vite/package.json)

The CLI's `bin/vite.js` launcher eventually imports `../dist/node/cli.js`. [CLI launcher](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/packages/vite/bin/vite.js)

Build sequence: remove `dist`, run `rolldown --config rolldown.config.ts`, run `rolldown --config rolldown.dts.config.ts`, then check emitted declarations with `tsc --project tsconfig.check.json`. `prepublishOnly` invokes `npm run build`. [Package scripts](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/packages/vite/package.json)

## JavaScript bundles and dependency policy

The direct Rolldown configuration defines five builds:

- Browser env: `src/client/env.ts` → `dist/client/env.mjs`, targeting ES2020.
- Browser client: `src/client/clientEntry.ts` → `dist/client/client.mjs`, ES2020, externalizing `@vite/env`.
- Bundled-development client: `src/client/bundledDevClient.ts` → `dist/client/bundledDevClient.mjs`, ES2020, externalizing `@vite/env` and `rolldown/experimental/runtime`.
- Node entries: `src/node/index.ts`, `cli.ts`, and `internalIndex.ts` → `dist/node/{index,cli,internal}.js`, with shared chunks under `node/chunks/`.
- Separate module runner: `src/module-runner/index.ts` → `dist/node/module-runner.js`.

Node outputs use ESM and `platform: 'node'`. The main Node build externalizes manifest dependencies and peers, plus selected optional imports and subpath patterns. The runner has its own external list, compression without mangling/codegen minification, and a 55 kB bundle guard. Custom plugins patch dependencies, rewrite source `import.meta.url` references, and collect licenses. Watch mode externalizes additional dev dependencies and enables inline maps; those are development accommodations. [Complete JavaScript build configuration](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/packages/vite/rolldown.config.ts)

Vite intentionally prebundles most runtime implementation dependencies. Its contribution guide consequently says to put most such packages in `devDependencies`. Exceptions include native/binary packages such as Rolldown and Lightning CSS, and packages whose own types must remain accessible in Vite's public API. Some otherwise problematic dependency types are inlined into `src/types`; shared `packages/vite/types` files are published without bundling. This is a deliberate policy for Vite's distribution, not a universal npm rule. [Dependency policy](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/CONTRIBUTING.md#notes-on-dependencies)

Bundled third-party licenses are collected into Vite's `LICENSE.md`; this explains why prebundling also entails license processing. [License plugin](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/packages/vite/rollupLicensePlugin.ts)

## Type declarations

`rolldown.dts.config.ts` uses **`rolldown-plugin-dts`**, with entries `index`, `module-runner`, and `internal`, producing declarations under `dist/node` and declaration chunks under `chunks/`. It externalizes Node, Vite/Rolldown subpaths, `#types` imports, dependencies, and peers. The plugin uses `tsconfig.base.json`, `emitDtsOnly: true`, and compiler overrides including `stripInternal: true` and `skipLibCheck: true`. Additional plugins rewrite PostCSS load-config declarations, normalize Node imports, validate dependency imports, remove internal declarations, and improve generated names. [Declaration configuration](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/packages/vite/rolldown.dts.config.ts)

The base TypeScript configuration enables `isolatedDeclarations`; it targets ES2023 with bundler module resolution. [Base configuration](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/packages/vite/tsconfig.base.json)

The final check covers `dist/**/*` and `types/**/*`, uses Node16 resolution and a conservative ES2020 library, and enables `exactOptionalPropertyTypes`. Thus declaration generation and checking the final published type surface are separate steps. [Final declaration check](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/packages/vite/tsconfig.check.json)

## Release and npm publication

1. **Prepare a release PR.** The manually dispatched Prepare Release workflow accepts a target branch, package, release increment, or exact version. It runs `scripts/prepare-release.ts`, then opens a release PR with `vitejs/release-scripts/action/release-pr`, pinned to release-scripts v1.10.0. [Preparation workflow](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/.github/workflows/prepare-release.yml)
2. **Update version/changelog.** The preparation script uses `prepareRelease`, `generateChangelog`, and `getReleaseTag` from `@vitejs/release-scripts`. Vite tags use `v<version>`; other package tags use their names. It constructs a PR body from the changelog. [Preparation script](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/scripts/prepare-release.ts)
3. **Detect the release commit.** Publishing runs on pushes to `main` and `v[0-9]*` branches, then calls a script that recognizes release commit subjects via `detectReleaseCommit`. A tag push or published GitHub release is not the trigger here. [Detection script](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/scripts/detect-release.ts)
4. **Publish, then create the GitHub release.** The publish job uses environment `Release`, `contents: write`, and `id-token: write`. It checks that the release tag does not already exist, disables dependency installation scripts, sets up pnpm with Node 26, installs npm `^11.5.2` for trusted publishing, and runs `pnpm run ci-publish "$TAG"`. It then creates the GitHub release/tag from the checkout SHA and extracted changelog. The workflow itself has no explicit test job dependency. [Publish workflow](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/.github/workflows/publish.yml)

The root `ci-publish` command runs `scripts/publishCI.ts`, which calls `publish({ defaultPackage: 'vite', packageManager: 'pnpm' })`. [Root manifest](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/package.json), [CI publish adapter](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/scripts/publishCI.ts)

The lockfile resolves `@vitejs/release-scripts` to **1.10.0**, so its source was also inspected at **`083fcf277cb3edc873f60d820738be35323d14e7`**. That implementation verifies the requested version against the package manifest and computes dist-tags: `alpha`/`beta` for supported prereleases, `previous` for stable releases older than npm's active version, otherwise the default tag. [Lockfile](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/pnpm-lock.yaml), [Release-scripts publish implementation](https://github.com/vitejs/release-scripts/blob/083fcf277cb3edc873f60d820738be35323d14e7/src/publish.ts)

Its pnpm path executes **`pnpm publish --access public --no-git-checks`**, adding a dist-tag when needed. It adds `--provenance` only when explicitly requested; Vite's adapter does not request that flag. The workflow's trusted-publishing setup and its actual provenance result are distinct from an explicit CLI provenance option. [Command construction](https://github.com/vitejs/release-scripts/blob/083fcf277cb3edc873f60d820738be35323d14e7/src/utils.ts)

Preview artifacts follow a separate workflow: build core and plugin-legacy, then publish through `pkg-pr-new` on main pushes or appropriately labeled PRs. That is separate from normal versioned npm releases. [Preview workflow](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/.github/workflows/preview-release.yml)

## Consumer library mode, tsdown, and “oxide”

**Vite library mode** is the consumer-facing `build.lib` option. Its docs demonstrate explicit dependency externalization through `build.rolldownOptions.external`, library entrypoints, package exports, and CSS output. Defaults are ES + UMD for one entry and ES + CJS for multiple entries. [Library mode guide](https://vite.dev/guide/build.html#library-mode)

At the pinned revision, `packages/vite/src/node/build.ts` implements library output choices and calls `rolldown(...)` directly. The live library guide retains wording about a “Rollup preset”; the current implementation is the stronger evidence for the actual bundler. Neither this consumer build nor Vite's own packaging should be described as currently implemented by tsdown. [Pinned consumer build implementation](https://github.com/vitejs/vite/blob/5def936009d2637a48d056e197aebc6242ac27c6/packages/vite/src/node/build.ts)

**tsdown** is an official Rolldown project aimed specifically at library authors. It wraps Rolldown with library-oriented defaults and declaration generation. Its introduction describes becoming a foundation for library mode as a future direction; that is not evidence Vite already uses it. [tsdown introduction](https://tsdown.dev/guide/)

The tsdown docs checked here identify version **0.23.7**. Dependencies, peers, and optional dependencies are external by default; imported dev dependencies can be bundled. Current customization lives under `deps`, including `neverBundle` and `onlyBundle`. [Dependency handling](https://tsdown.dev/options/dependencies)

Declarations use `rolldown-plugin-dts`. Set `dts: true` explicitly, or provide a manifest type entry that enables it automatically. With `isolatedDeclarations`, tsdown documents an Oxc transform path; otherwise it uses the TypeScript compiler. For an inference-heavy Effect API, retain normal TypeScript declaration inference initially unless explicit exported annotations make isolated declarations practical. This last sentence is project advice, not a Vite requirement. [Declaration documentation](https://tsdown.dev/options/dts)

**“Oxide” likely means Oxc**, though the name is ambiguous. Oxc supplies parser, transformer, minifier, resolver, linting (Oxlint), and formatting (Oxfmt) tools. It is not itself the complete npm release pipeline. [Oxc tools](https://oxc.rs/docs/guide/introduction.html)

**Rolldown** is the general-purpose Rust bundler powering Vite 8+. For this request, the relevant tool names are therefore Oxc, Rolldown, and tsdown. [Rolldown](https://rolldown.rs/)

## Recommendation for a small Effect TypeScript library

Use **tsdown** if choosing a library packaging tool from this ecosystem. Start with ESM, explicit public entries, `dts: true`, a separate TypeScript check, and a small `files` allowlist. Keep `effect` and `effect/*` imports external; if consumers supply Effect and the public API exposes its types, recommend a compatible `peerDependencies.effect` range plus a development dependency. This is a design recommendation, not a claim about Vite's dependency policy or an Effect mandate. tsdown's documented externalization defaults support this arrangement. [tsdown dependency defaults](https://tsdown.dev/options/dependencies)

Do not copy Vite's custom dependency shims, browser clients, declaration patches, or release monorepo machinery. Use Vite library mode when its browser asset/CSS/plugin handling is needed. Plain TypeScript emission remains a reasonable simpler choice when no bundling is needed. Before release, inspect a real npm tarball and smoke-test its exports and declarations in a consumer with Effect installed. Keep package building separate from versioning and registry publication; a deliberate single-package release workflow is enough initially. These are recommendations based on the source findings above, not implementation changes made by this research.
