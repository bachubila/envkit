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

| envkit concept | Bitwarden mapping                                                                      |
| -------------- | -------------------------------------------------------------------------------------- |
| Team           | Organization                                                                           |
| Project        | Collection (e.g. `myapp`)                                                              |
| Environment    | One item per environment in the collection: `myapp/dev`, `myapp/prod`                  |
| Variable       | Hidden custom field on that item (`name` = key, `value` = value)                       |
| Item marker    | Secure Note type; notes start with `envkit:v1`, then `project=` / `environment=` lines |

By default all of a project's environments share one collection. For per-environment access control (e.g. only some people can read prod), put an environment in its own collection with `envkit env add prod --collection myapp-prod`. `.envkit.json` stores a collection per environment, so both layouts work everywhere.

## Repo layout

```
packages/
  core/     # backend interface, bw backend, config, env resolution (library, no CLI deps)
  cli/      # `envkit` binary: argument parsing, prompts, output
tools/
  testkit/  # private: fake `bw`, in-memory FakeVault, disposable Vaultwarden, integration tests
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

## Phase 1 — Vault backend and auth ✅

**Goal:** log in to a Vaultwarden server and unlock the vault from envkit.

- [x] `VaultBackend` interface in `core`: `status`, `setServer`, `login`, `loginWithApiKey`, `unlock`, `lock`, `logout`, `sync`, `listOrganizations`, `listCollections`, `getItem`, `createItem`, `updateItem`.
- [x] `BwCliBackend`: every call is `bw … --response` (structured JSON, including the session key in `data.raw`). Passwords go through `--passwordenv`, sessions through `BW_SESSION`, item payloads through stdin, so no secret ever appears in argv. `bw` errors are translated into actionable messages with hints.
- [x] Detect `bw`: a missing binary or one older than `MIN_BW_VERSION` (2026.1.0) gives install instructions. `ENVKIT_BW_PATH` overrides the path.
- [x] `envkit login [--server <url>] [--email <email>] [--apikey]`: envkit asks for the URL, email and password itself. `bw` still prompts on the terminal for 2FA or new-device codes. API-key login uses `BW_CLIENTID` / `BW_CLIENTSECRET` and then unlocks.
- [x] `envkit unlock` / `envkit lock`, plus `envkit logout` (not in the original plan, but needed to switch accounts).
  - The session is kept in the OS keychain (`@napi-rs/keyring`). Without a working keychain it stays in memory, so every command asks for the password.
  - Idle timeout of 60 minutes (`ENVKIT_SESSION_IDLE_MINUTES`). Every use resets it; `status` doesn't.
  - Up to three attempts for a mistyped password.
- [x] `envkit status [--json]`: server, account, locked/unlocked, when it locks, last sync, where sessions are stored.
- [x] Tests:
  - `core`: `BwCliBackend` against a fake `bw` executable (args, env, stdin, error mapping, version check).
  - `cli`: every command in-process against `FakeVault`, an in-memory backend that follows `bw`'s rules.
  - Integration (`vp run test:integration`, own CI job): real `bw` 2026.10.0 against Vaultwarden 1.37.5 in Docker, including a login in one process that the next process sees.

**Done when:** a user can log in to a local Vaultwarden (docker) and `envkit status` shows the vault unlocked. ✅ Covered by the integration tests.

What we learned (and what later phases need to know):

- **envkit uses its own `bw` data dir** (`$ENVKIT_HOME/bw`, default `~/.config/envkit/bw` on Linux). This keeps it separate from the user's personal `bw` login and server, so the user's own `BW_SESSION` is never passed to envkit's `bw`.
- **`bw` refuses non-HTTPS servers, even `localhost`.** `normalizeServerUrl` rejects `http://` up front. Self-signed servers need `NODE_EXTRA_CA_CERTS` pointing at their CA.
- **Every `unlock` invalidates earlier session keys**, and so does `bw lock`. envkit checks a cached session with `bw status` before using it and drops it if it's dead.
- **`bw sync` works while the vault is locked.** It only needs the login token. Reading data needs the session.
- **Item updates re-read the full item**, because `bw edit` replaces the whole item. Fields envkit doesn't own are kept.
- **Vaultwarden 1.37 removed the legacy `/identity/accounts/register` route.** The test kit registers accounts through `register/send-verification-email` + `register/finish`, doing the client-side crypto itself. `bw` can't create organizations either, so **Phase 2 needs a similar test helper to create an org and collections**.
- `bw` calls are slow (about 1–3 s each because of Node startup and KDF), and `requireSession` costs two of them before any real work. If this becomes painful, cache the status per run or move to the native backend (Phase 7).
- **Env vars added:** `ENVKIT_HOME`, `ENVKIT_BW_PATH`, `ENVKIT_SERVER`, `ENVKIT_EMAIL`, `ENVKIT_PASSWORD`, `ENVKIT_SESSION`, `ENVKIT_SESSION_IDLE_MINUTES` (plus `BW_CLIENTID` / `BW_CLIENTSECRET`). Phase 5 builds on these.
- **Not verified yet:** the interactive prompts in a real terminal (`@clack/prompts`), `bw`'s 2FA prompts, and the macOS and Windows keychains. Check them by hand before release (Phase 6).

## Phase 2 — Project linking ✅

**Goal:** connect a repo to an org, collection and environment.

- [x] `.envkit.json` schema (validated with `valibot`): `version`, `server`, `organizationId`, `project`, `defaultEnvironment`, `environments: { <name>: { collectionId, itemId } }`. Written with fixed key order and sorted environments to keep diffs small. It holds IDs only and is meant to be committed.
- [x] `envkit init [--org] [--project] [--collection] [--env dev,prod] [--force]`: picks the org (flag, the only one, or a prompt), then finds or creates the collection and finds or creates one item per environment. Re-running it reuses everything.
- [x] `envkit link <project> [--org] [--env] [--force]`: writes `.envkit.json` for a project that already exists in the vault, found by the item marker. **Teammates normally don't need it**: once `.envkit.json` is committed, a clone plus `envkit login` is enough. `link` is for repos without the file, or for recreating it.
- [x] `envkit env list` (variable count per environment, and fails if any can't be opened), `envkit env add <name> [--collection] [--default]`, `envkit env remove <name> [--delete]` (`--delete` moves the item to the trash).
- [x] Config is found by walking up from the current directory, so commands work in monorepo subdirectories; the nearest `.envkit.json` wins.
- [x] Warn when the configured server doesn't match the logged-in server (`env` commands; Phase 3 commands should reuse `warnOnServerMismatch`).

**Done when:** a second user on another machine can clone the repo, run `envkit login` and resolve the same items. ✅ The integration test runs two real accounts: Alice runs `init`, Bob is added to the org with access to the collection, and Bob's `env list` resolves the same items from a copy of `.envkit.json`.

What we learned (and what later phases need to know):

- **Never let a non-admin try to create a collection.** Vaultwarden answers with a 401 instead of a 403, and `bw` then **logs the user out**. `canCreateCollections()` (owner or admin only) gates every `createCollection` call, and `FakeVault` copies the logout so a regression fails the tests. Managers and custom roles are treated as unable to create collections; that could be relaxed later.
- **`bw` reads a local copy of the vault.** Newly granted access, or a collection a teammate just created, stays invisible until `bw sync`. `init`, `link` and `env` sync first, which also prevents duplicate collections. Phase 3's planned "sync when the cache is older than N" fits here.
- **`bw get item` still returns trashed items.** The backend treats an item with `deletedDate` as gone, and `listItems` skips them.
- **Items are found by the notes marker, not the name.** Renaming an item in the web vault doesn't break `init` or `link`. Project matching is exact, so `myapp` doesn't match `myapp-api`.
- **The test kit's `VaultwardenApi` now creates organizations and adds and confirms members** (org key wrapped with RSA-OAEP). Phase 3+ integration tests can build on `cliUser()` in `tools/testkit/tests/setup.ts`.
- **Not done:** pruning dangling environments (an item deleted in the web vault stays in `.envkit.json` until `env remove`; `env list` reports it), and renaming a project.

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
- [x] Integration tests against Vaultwarden in docker (`vaultwarden/server`), run in CI. Done in Phase 1 (`tools/testkit`). Extend them as each phase adds commands.
- [ ] Manual check of interactive prompts, 2FA and the macOS/Windows keychains (see Phase 1 notes).
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

1. **Minimum `bw` version and Vaultwarden version** we support. Tests currently pin `bw` 2026.10.0 and Vaultwarden 1.37.5; `MIN_BW_VERSION` is 2026.1.0 but untested below 2026.10.0. Add a version matrix to the integration job or raise the minimum.
2. **Session storage:** Phase 1 uses the OS keychain and falls back to "prompt every time" when there is none. Confirm that fallback is acceptable, or add an opt-in encrypted file store.
3. ~~**Environment layout default:**~~ Resolved in Phase 2: one collection per project by default; `env add --collection` puts an environment in its own collection.
4. ~~**Package name:**~~ Resolved: `envkit` is free on npm (checked 2026-11-03). The library is `@envkit/core`, so we need to claim the `@envkit` npm scope before publishing.
5. **License.**
