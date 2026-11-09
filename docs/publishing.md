# Publishing Effective and its skill

The package is ESM-only. tsdown builds JavaScript and declarations into `dist/`. The npm
allowlist includes `dist/`, `AGENTS.md`, `ai-docs/`, and `skills/`; npm also includes the package
manifest and README. The installable `skills/effective/SKILL.md` is only a pointer to
`node_modules/@mtdn.dev/effective/AGENTS.md`. Detailed instructions and examples live in
the package's `AGENTS.md` and `ai-docs/`, rather than being copied into the installed skill.
This follows [Effect's skill](https://github.com/Effect-TS/skills/blob/main/skills/effect-ts/SKILL.md)
and its [package files](https://github.com/Effect-TS/effect/blob/main/packages/effect/package.json).

## Before the first release

1. Keep the `MIT` designation in the manifest and include the root `LICENSE` in the tarball.
   The license applies to the library and its bundled skill.
2. Review integration coverage for the intended deployment. Current tests cover real SQLite
   transactions; PostgreSQL deployments and persistent worker restart recovery need additional coverage.
3. Confirm npm publish rights to the exact `@mtdn.dev` scope and enable account 2FA. Domain
   ownership alone does not establish an npm namespace.
4. Commit the sources, skill, and lockfile. Use Node 24, npm 12.2.2, and Bun 1.4.4.
5. Run `npm ci` and `npm run check`. This includes build, tests, publint, tarball installation,
   ESM imports, optional Drizzle storage, and compilation of the package's TypeScript examples.

No registry release has been performed as part of adding this configuration.

## Bootstrap and configure trust

A new package must exist on npm before configuring its trusted publisher. For the first
real version, an authorized maintainer can use:

```sh
npm login
npm publish --access public
```

The publish hooks run validation and build the package. Keep the initial version and Git tag
aligned. After a manual `0.1.0` bootstrap, create the `v0.1.0` tag as the skill-installation
reference before enabling the automatic publishing workflow on npm, or use a tag-only push
with the Publish workflow disabled. Do not let the workflow republish the bootstrap version.
Each published name/version is immutable; subsequent releases need a new version.

Configure the package's npm trusted publisher with:

- GitHub owner: `mattddean`
- Repository: `effective`
- Workflow filename: `publish.yml`
- GitHub environment: `npm`
- Permission: allow direct publishing (new trust configurations may default to staging only)

Create the matching GitHub `npm` environment and any desired release protections. Complete
the first trusted publication within npm's configuration activation window. Once verified,
disable traditional publishing tokens and revoke obsolete credentials. No `NPM_TOKEN` is
needed by the workflow. A public package published by trusted GitHub Actions from a public
repository receives provenance automatically; a local bootstrap does not gain it retroactively.

## Subsequent versions

Update `package.json` and the lockfile to the next version, update any versioned installation
examples, and commit. Push a matching `v<version>` tag. The Publish workflow checks tag/version
agreement, installs the locked dependencies, runs `npm run check`, then publishes with OIDC.
It uses `--ignore-scripts` for the publish step because validation and the build just ran.
The checked-out commit must contain the package guidance before tagging.

The workflow is intended for stable releases. For a prerelease, explicitly select a separate
npm dist-tag such as `next` before publishing so it does not replace `latest`.

## Skill installation

Consumers install the package and register the pointer skill from GitHub:

```sh
npm install @mtdn.dev/effective effect@~4.1.2
npx skills@1.7.3 add mattddean/effective
```

They can also install the same pointer from the npm dependency:

```sh
npx skills@1.7.3 add ./node_modules/@mtdn.dev/effective
```

The CLI installs the small pointer into the consumer's selected agent directories. The skill
reads the installed package's `AGENTS.md` and follows its package-relative documentation links.
Updating the npm dependency updates the detailed guidance automatically, even when the skill
installer copied its files. The pointer does not need a tag matching the library version.

The GitHub route requires access to this repository. npm installation alone does not register
agent skills. No separate skill repository, npm package, or registry submission is required.

Sources: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
[skills CLI](https://github.com/vercel-labs/skills/blob/main/docs/commands.md).
