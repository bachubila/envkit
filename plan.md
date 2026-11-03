# envkit — Build Plan

envkit lets teams share environment variables through a self-hosted **Vaultwarden** (Bitwarden-compatible) server. Secrets are encrypted on the client with the Bitwarden protocol; the server only stores ciphertext. A developer needs **their own vault account (email + master password)** and the **vault URL**. Nothing else.

We ship it as a **CLI first**. A website or dashboard can come later.

---

## Guiding principles

- **Each person has their own account.** No shared master password. Team access goes through Bitwarden **Organizations + Collections**, so we can remove one member without rotating everything and we keep an audit trail.
- **Don't write our own crypto in v1.** Encryption and decryption go through the official `bw` CLI. That backend sits behind a `VaultBackend` interface, so a native TypeScript client can replace it later.
- **Keep plaintext off disk by default.** `envkit run -- <cmd>` puts variables into the child process's environment. Writing a `.env` file is an explicit opt-in.
- **Config is safe to commit.** `.envkit.json` holds only IDs and names, never secret values.
- **Data stays in the Bitwarden UI.** A team member can view and edit envkit secrets in any Bitwarden client.

## Data model

| envkit concept | Bitwarden mapping                                                     |
| -------------- | --------------------------------------------------------------------- |
| Team           | Organization                                                          |
| Project        | Collection (e.g. `myapp`)                                             |
| Environment    | One item per environment in the collection: `myapp/dev`, `myapp/prod` |
| Variable       | Hidden custom field on that item (`name` = key, `value` = value)      |
| Item marker    | Secure Note type; notes field holds `envkit:v1` + metadata            |

Access control per environment (e.g. only some people can read prod) works by splitting environments into separate collections: `myapp-dev`, `myapp-prod`. `link` supports both layouts.

## Repo layout

```
packages/
  core/     # backend interface, bw backend, config, env resolution (library, no CLI deps)
  cli/      # `envkit` binary: argument parsing, prompts, output
apps/
  website/  # existing starter, later becomes the docs site (Phase 7)
```

Both packages use `vp pack` for builds, `vp test` (Vitest) for tests, `vp check` for format, lint and types.

---

## Phase 0 — Scaffold ✅

**Goal:** an empty `envkit` binary that builds, tests and runs.

- [x] Create `packages/core` (`@envkit/core`) and `packages/cli` (`envkit`). Removed the unused `packages/utils`.
- [x] Argument parser: `citty`. Prompt library (`@clack/prompts`) moves to Phase 1, where the first prompt (`login`) appears.
- [x] Add a `bin` entry `envkit` → `packages/cli/dist/bin.mjs`.
- [x] Commands: `envkit --version`, `envkit --help`.
- [x] Root script: `vp run envkit <args>` runs the CLI from source during development (no build needed).
- [x] CI (`.github/workflows/ci.yml`) runs `vp run ready` on Node 22.18 and 24, then smoke-tests the built binary.

Notes for later phases:

- `@envkit/core` exports a `source` condition pointing at `src/index.ts`. The CLI tests, `vp run envkit` and the Node dev script use it, so nothing has to be built first. Published consumers get `dist/`.
- `run(argv, output)` in `packages/cli/src/run.ts` never calls `process.exit`, so commands can be tested in-process. Throw `EnvkitError` (with an optional `hint` and `exitCode`) for expected failures. Anything else is reported as a bug with exit code 70.
- The root command has a temporary `run` that rejects unknown commands. Remove it when the first subcommand is added in Phase 1 (citty would otherwise run it after every subcommand).

**Done when:** `vp run ready` passes and `envkit --help` prints the command list.

## Phase 1 — Vault backend and auth

**Goal:** log in to a Vaultwarden server and unlock the vault from envkit.

- [ ] Define the `VaultBackend` interface in `core`: `status`, `login`, `unlock`, `lock`, `listOrgs`, `listCollections`, `getItem`, `createItem`, `updateItem`, `sync`.
- [ ] `BwCliBackend`: wraps `bw` with `--raw` / `--response` JSON output, passes the session through the `BW_SESSION` env var (never as an argument) and gives clear errors.
- [ ] Detect `bw`: if it's missing or too old, print install instructions.
- [ ] `envkit login [--server <url>]`: runs `bw config server`, then `bw login`. Supports interactive login and API-key login (`BW_CLIENTID` / `BW_CLIENTSECRET`).
- [ ] `envkit unlock` / `envkit lock`: cache the session token.
  - Store it in the OS keychain where available (`@napi-rs/keyring` or similar). Otherwise keep it in memory only and prompt every time.
  - Configurable timeout; by default the session expires with the shell or after N minutes.
- [ ] `envkit status`: server URL, logged-in email, locked/unlocked state.
- [ ] Tests: unit-test the backend against a fake `bw` executable (fixture JSON responses).

**Done when:** a user can log in to a local Vaultwarden (docker) and `envkit status` shows the vault unlocked.

## Phase 2 — Project linking

**Goal:** connect a repo to an org, collection and environment.

- [ ] `.envkit.json` schema (validate with `zod` or `valibot`):
  ```json
  {
    "version": 1,
    "server": "https://vault.acme.dev",
    "organizationId": "…",
    "project": "myapp",
    "environments": {
      "dev": { "collectionId": "…", "itemId": "…" },
      "prod": { "collectionId": "…", "itemId": "…" }
    },
    "defaultEnvironment": "dev"
  }
  ```
- [ ] `envkit init`: interactive. Pick an org and a collection (or create a collection if the user has permission), then create the env items.
- [ ] `envkit link <project> [--env <name>]`: links an existing project without prompts, for teammates cloning the repo.
- [ ] `envkit env list` / `envkit env add <name>` / `envkit env remove <name>`.
- [ ] Find the config by walking up from the current directory, so it works from subdirectories in a monorepo.
- [ ] Warn when the configured server doesn't match the logged-in server.

**Done when:** a second user on another machine can clone the repo, run `envkit login` and resolve the same items.

## Phase 3 — Reading secrets (the core value)

**Goal:** developers get their env vars with one command.

- [ ] `envkit run [--env <name>] -- <cmd...>`: fetch, merge into `process.env`, spawn the child with stdio inherited, forward signals and pass through the exit code.
- [ ] `envkit pull [--env <name>] [--out .env] [--format dotenv|json|shell]`: explicit export. Warn if the output file isn't in `.gitignore`.
- [ ] `envkit get <KEY>`: prints one value (for scripts).
- [ ] `envkit list`: lists keys only. Values are masked unless `--reveal` is passed.
- [ ] Precedence rules (document them): existing shell env vs vault values. Default: the vault wins, `--no-override` keeps existing values.
- [ ] Optional variable references (`${OTHER_KEY}`). Decide now whether to support them, but they can ship later.
- [ ] Sync before reading (`bw sync`) when the local cache is older than a threshold; `--offline` skips it.

**Done when:** `envkit run -- node -e "console.log(process.env.API_KEY)"` prints the value stored in Vaultwarden.

## Phase 4 — Writing secrets

**Goal:** manage variables without opening the Bitwarden UI.

- [ ] `envkit set KEY=value [KEY2=value2…] [--env <name>]`: reads the value from stdin when it's omitted, so secrets stay out of shell history.
- [ ] `envkit unset KEY…`.
- [ ] `envkit push [--from .env]`: bulk import that shows a diff and asks for confirmation.
- [ ] `envkit diff --env dev --env prod`: compares keys only, to catch missing variables.
- [ ] Concurrency: re-fetch before every write and refuse to save if the item's `revisionDate` changed since the read.

**Done when:** one user's `set` shows up in another user's `run` after a sync.

## Phase 5 — CI / non-interactive use

**Goal:** envkit runs in pipelines without prompts.

- [ ] Detect CI (`CI=true`) or `--non-interactive`: never prompt, fail fast with a clear error.
- [ ] Auth from env vars: `ENVKIT_SERVER`, `BW_CLIENTID`, `BW_CLIENTSECRET`, `ENVKIT_PASSWORD` (the master password of a dedicated CI vault account).
- [ ] Document the recommended setup: one CI user per project, added to the org with **read-only** access to only the collections it needs.
- [ ] GitHub Actions example workflow in the docs.
- [ ] Keep secrets out of logs (never echo values; mask them when GitHub Actions `::add-mask::` is available).

**Done when:** a sample GitHub Actions workflow runs `envkit run -- vp test` against a Vaultwarden instance.

## Phase 6 — Hardening and distribution

- [ ] Security review: process args (no secrets in argv), temp files, file permissions on any cache, session-token lifetime, error messages that might leak values.
- [ ] `envkit doctor`: checks `bw` version, server reachability, login state, config validity and `.gitignore` coverage.
- [ ] Integration tests against Vaultwarden in docker (`vaultwarden/server`), run in CI.
- [ ] Publish to npm (`npx envkit`, `pnpm dlx envkit`). Consider single-file binaries later.
- [ ] Docs: README quickstart, command reference, team setup guide (org, collections, roles).
- [ ] Versioning and changelog (changesets or similar).

**Done when:** a new team can go from zero to `envkit run` by following the README alone.

## Phase 7 — Later / optional

- [ ] **Native TypeScript backend:** implement the Bitwarden client crypto (KDF → master key → user key → org key → item decryption) so `bw` is no longer required. Tests must check it against the `bw` backend.
- [ ] Shell integration: a `direnv`-style hook that loads variables when you `cd` into a project.
- [ ] Editor and runtime integrations (VS Code extension, Vite/Node loaders).
- [ ] Turn `apps/website` into the docs and marketing site.
- [ ] Secret rotation helpers and an audit view (who changed what, from Bitwarden events where available).

---

## Open questions

1. **Minimum `bw` version and Vaultwarden version** we support. Pin and test both.
2. **Session storage:** is the OS keychain a hard requirement, or is "prompt every time" an acceptable fallback on Linux without a keyring?
3. **Environment layout default:** one collection per project (simpler) or one per environment (finer access control)?
4. ~~**Package name:**~~ Resolved: `envkit` is free on npm (checked 2026-11-03). The library is `@envkit/core`, so we need to claim the `@envkit` npm scope before publishing.
5. **License.**
