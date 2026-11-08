# AGENTS.md

Working rules for this repository. Detailed reference lives in the linked
documents — read the one your task needs rather than carrying all of it here.

## Read as needed

- [Architecture](docs/architecture.md) — layers, source layout, the Bot team
  model, the IM channels and the data flow. Read when changing module
  boundaries or when a term is unclear.
- [Contracts](docs/contracts.md) — the DSH plugin entry, the `api/bot` channel,
  the IM adapter contract, the generated bundles and team data. Read before
  changing a public shape.
- [UI standard](docs/design/ui-standard.md) — interface rules, in Chinese. Read
  before changing the client.

## Working language

Repository docs are in Chinese, one version only — no English mirror. Two
exceptions stay English: this file, because agents read it as working rules, and
`CHANGELOG.md`, which records releases. Code comments and commit messages are in
English. User-facing plugin text is English; the client i18n carries the Chinese
copy. Conversation follows the user's language. Keep quoted code, error output
and quoted material in their original language.

Use Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
`test:`.

## What this project is

Ocean Crew is a team of long-lived Bots built on DeepSeek Harness (DSH), shipped
as a DSH plugin. `ocean-crew/` is the product: one TypeScript package that builds
a DSH plugin. `src/host/` runs in DSH's Node process, `src/client/` builds into
`client.js` for the DSH Desktop window, and `npm run build` writes both `dist/`
and `client.js`. The build products stay out of git: install after building.
The root carries the tooling — the shared TypeScript configuration, Biome, the
leak scan and the CI workflow. The plugin inside **DSH Desktop** is the only
supported form, and nothing else is shipped or supported.

Every Bot is a long-lived identity whose work runs in DSH Sessions: one for its
own chat, one per group, and a fresh one when the context fills up. Bots message
each other, share group chats and hand work across. Users customize each Bot's
name, role, instructions, model and character. The conversation, browser and IM
surfaces belong to Ocean Crew; the agent loop, tools and models are DSH's.

Development reaches the real thing through `ocean-crew/dev/install-local.mjs`,
which copies this checkout's build into the machine's DSH Desktop profile (build
first: `cd ocean-crew && npm run build`).

This repository (`9Ashwin/ocean-crew`) is the owner's personal project for
learning and everyday use; the plugin keeps its `ocean-crew` package name. It is
public so DSH can install the plugin from it, and it is not a product. Do not
write in the docs or comments that the project references, adapts or is derived
from another project, do not link to other projects, and do not introduce or
recommend similar projects; the only legally required attribution lives in
`THIRD_PARTY_NOTICES.md`.

Two commitments shape most of the code:

- **Build on DSH; never patch it.** Bot features use the documented plugin APIs
  (Cordis services, the plugin client entry, profile patches). Never patch
  DeepSeek Harness or depend on files inside a DSH install. If DSH is missing
  something, stop and say so.
- **Behavior must be reliable.** A Bot acts on evidence, stays inside its goal,
  and its results can be checked. A hidden failure is a bug; do not hide one to
  make a gate pass.

## Code and behavior

- Read the affected files before changing them, and trace the owner of the
  behavior before choosing a fix. Do not add a second implementation of a
  mechanism that already exists.
- `ocean-crew/client.js` is generated: change `ocean-crew/src/client/` and run
  `cd ocean-crew && npm run build`. Never edit it by hand, and do not commit it.
- The plugin entry, the `api/bot` channel, the IM adapter contract, the team
  data files and the built bundles are public contracts; see
  [docs/contracts.md](docs/contracts.md). Preserve their exact shapes, error
  codes and accepted text unless the task says otherwise.
- Host state belongs to the host: read and write it through the host module.
  Never edit `~/.dsh/bot/state.json`, `secrets.json` or DSH data from outside.
  Tests and the bench keep their data in `.dsh-test-<name>/`.
- A feature's design lives in the task PRD under the local `tasks/` directory
  (git-ignored, see below). `docs/` holds reference, not new designs.
- Keep user-facing plugin text English. Repository docs are Chinese single
  versions; keep them accurate as code changes. Leave `CHANGELOG.md` alone
  unless the task asks for an entry.

## TypeScript

All product code is TypeScript (`ocean-crew/src/**/*.ts`, tests in
`ocean-crew/test/**/*.ts`). `ocean-crew/tsconfig.json` extends the root
`tsconfig.base.json`, the shared strict configuration; `tsc --noEmit` is the check.

- Erasable syntax only: no `enum`, `namespace`, parameter properties, `import =`
  or `export =`. Node strips types, so the syntax must not need a transform.
- `verbatimModuleSyntax`: type-only imports use `import type`; no runtime import
  for a type.
- Imports are top-level and static; no inline `await import()` and no dynamic
  type imports.
- Types and checks: tagged unions for states and results; cast only for an
  invariant TypeScript cannot express and say why. Validate at trust boundaries
  (wire input, schema-checked tool arguments), not for values the types already
  guarantee.
- One concept per file, named after it; the first line says what the file is for.
  No runtime checks of values whose types the compiler already enforces.
- Keep the build working: `cd ocean-crew && npm run build` compiles `src/` to
  `dist/` and bundles `src/client/` to `client.js`. Both are local build
  products, ignored by git.

## Checks

Run at the repository root: the root scripts cover type checking, Biome, the
unit tests and the build-product checks, and the plugin's own build lives in
`ocean-crew/`. The tests and the type checker load the `@deepseek-ai/*` packages
from a DSH harness/checkout: `DSH_HARNESS`, a harness installed beside the
repository, or the nearest DSH checkout (see
`ocean-crew/test/harness-resolve.mjs`).

```sh
npm run check                # types, Biome, unit tests, then build and build-product checks
npm run build                # build the plugin: dist/ + client.js
cd ocean-crew && npm test    # unit tests only
```

A change is done when `npm run check` passes. CI
(`.github/workflows/test.yml`) runs the same gates on pushes to `main`, plus a
leak scan of the tracked tree.

Changes to host code also need the smoke test. `cd ocean-crew && npm run build`
first, then `node ocean-crew/dev/smoke.mjs` boots DSH from a DSH harness/checkout
through a throwaway home under the repository root and checks the plugin end to
end over HTTP (options: `--name`, `--port`, `--mock-port`, `--harness`,
`--keep-data`). Set `DSH_HARNESS` or pass `--harness` when the checkout has no
local DSH harness. Use a free port, skip what the machine cannot run, and say
so.

## Verification and evidence

- A unit test is not proof of real-platform behavior. IM changes need a real
  Feishu or WeChat round trip recorded in the task, never claimed from a unit
  test.
- Read generated or bulk-edited files back. A verifier must reach the condition
  it claims to test.
- Keep verification evidence in the local task directory
  (`tasks/<task>/evidence/`), unless the task explicitly ships an artifact.
- Do not weaken a gate, delete a failing case, or skip a platform check to make
  a change look finished. Preserve the original error and expose it.

## Git and delivery

- This is a personal repository: work directly on `main` unless the task says
  otherwise. Keep commits small and in Conventional Commits.
- Commit and push only as the user asks. Never push to another repository,
  never open a pull request, and never publish a release or package on your
  own.
- Stage explicit paths and inspect the staged diff before committing. Do not
  commit secrets, `DSH_HOME` contents, local state or screenshots with personal
  data.
- The plugin is installed from this checkout rather than packaged: build first
  (`cd ocean-crew && npm run build`), then run
  `node ocean-crew/dev/install-local.mjs`. A bare clone has no `dist/` or
  `client.js`, so it cannot load until it is built.

## Task records

Multi-step work keeps local records under `tasks/NN-<name>/`: `prd.md` (goal,
constraints, acceptance), `progress.md` (per-round evidence) and, for L2 work,
`checkpoint.md`, with verification evidence in the task's `evidence/` directory.
`tasks/` is git-ignored: the records are working notes for this machine and are
never committed. One task keeps one state. Deer's task loop rules apply, but the
record is owned in this checkout — do not register project work in the Deer
workspace; Deer keeps only its own maintenance tasks.

## Secrets and user data

- Never write, print or commit API keys, tokens, cookies or `DSH_HOME`
  contents. Use a mock model or a throwaway DSH bench for tests; it needs no
  key.
- Never point a test at `~/.dsh` or at the DSH Desktop the user runs. The only
  write into a real profile is `ocean-crew/dev/install-local.mjs`, which backs up the
  installed copy first; do not restart the user's DSH without asking.
- CI scans the tracked tree for secrets and personal data
  (`scripts/scan.mjs`); keep the repository clean enough to pass it.

## What the project must never do

- Patch DSH, or depend on files inside a DSH install, to make a feature work.
- Commit a secret, or put one in a test fixture.
- Send an IM message to an account the user did not pair, or act on a platform
  identity the user did not choose.
- Hide a failure by weakening a check, deleting a case or skipping a platform
  verification.

## Licensing

Only original material for anything added now; do not copy an icon, logo or
text from another product into Ocean Crew's own interface. Do not remove the
required license attribution: it lives in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The project is under MIT; see
[LICENSE](LICENSE).
