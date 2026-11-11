---
name: effective
description: Set up agent instructions for repositories using @mtdn.dev/effective, or work with its capability modules, services, CLI commands, and transactional domain events.
---

## 1. Locate the installed package

Use the `@mtdn.dev/effective` installation resolved by the workspace being changed.
If setting up a new consumer, install the package with the user's preferred package
manager. Preserve an existing installation and its version.

## 2. Update AGENTS.md / CLAUDE.md

Ensure the repository's agent instructions contain the following section. Update the
existing `AGENTS.md` or `CLAUDE.md`; create `AGENTS.md` if neither exists. Preserve
unrelated instructions and update an existing Effective section rather than duplicating it.

```md
# Learning more about Effective

This repository uses the Effective TypeScript library (`@mtdn.dev/effective`).

Before writing any Effective code, first read
`node_modules/@mtdn.dev/effective/AGENTS.md` completely and follow its links when required.
For API signatures not covered by the guide, inspect the installed package's
`dist/index.d.ts` and `dist/storage/drizzle.d.ts` declarations.
```

In monorepos or with hoisted dependencies, use the installed package path reachable
from the instruction file's directory. Documentation links are relative to that package.

## 3. Read the installed guidance

Read the installed package's `AGENTS.md` completely before working on Effective code.
The instructions and linked examples track the application's installed library version.
