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

## Phase 3 — Reading secrets (the core value) ✅

**Goal:** developers get their env vars with one command.

- [x] `envkit run [-e <env>] [--no-override] [--offline] -- <cmd...>`: spawns the command with inherited stdio in the project directory. It forwards SIGINT/SIGTERM/SIGHUP/SIGQUIT and passes the exit code through (128 + signal number when a signal killed the child, 127 for an unknown command). Only args before `--` count as envkit's, so `envkit run -- node --help` reaches node.
- [x] `envkit pull [-e] [--out .env] [--format dotenv|json|shell]`: stdout by default. `--out` writes with mode 600 and warns when git would pick the file up (`git check-ignore`).
- [x] `envkit get <KEY>` prints one value; `envkit list [--reveal]` prints names with masked values.
- [x] `envkit sync` (new): forces a sync, e.g. right after a teammate changed a value or gave you access.
- [x] **Precedence (decided):** vault values replace variables already set in the shell. `--no-override` keeps the shell's. `ENVKIT_PASSWORD` and `ENVKIT_SESSION` are always removed from the child's environment, so the app never sees the master password.
- [x] **Variable references (decided): not supported.** Values are literal; `$`, `${HOME}` and backticks are never expanded, in `run` or in any output format. Revisit only if users ask.
- [x] **Sync policy:** sync before reading when `bw`'s last sync is older than `ENVKIT_SYNC_INTERVAL_MINUTES` (default 5; 0 = always). `--offline` skips it. A teammate's change therefore shows up within 5 minutes, or straight away after `envkit sync`.

**Done when:** `envkit run -- node -e "console.log(process.env.API_KEY)"` prints the value stored in Vaultwarden. ✅ The integration test does exactly that through the real binary, then has a second user read the same values and pick up a rotated value after `envkit sync`.

What we learned (and what later phases need to know):

- **Field → variable rules:** text, hidden and boolean custom fields become variables (an empty value becomes `""`). Invalid names (`my key`, `1ST`) and linked fields are skipped with a warning; for duplicate names the last field wins, also with a warning. Phase 4's `set` must refuse invalid names up front.
- **`.env` quoting is checked against the `dotenv` package.** dotenv keeps single- and backtick-quoted text literally (real newlines included) and only expands `\n`/`\r` inside double quotes, with no other escapes. envkit picks bare → `'…'` → `` `…` `` → `"…"` and **refuses** values no form can hold exactly (quotes of every kind mixed with line breaks), pointing at `--format json|shell`. Shell output uses POSIX single quotes and round-trips through `sh` in tests.
- **`ENVKIT_SESSION_STORE=memory`** (new) keeps envkit out of the OS keychain. The integration tests use it for spawned binaries; it's also useful on shared machines.
- **Latency:** each read costs about 3–4 `bw` processes (status, status with session, maybe sync, get item), so 3–6 s per `envkit run`. That's acceptable for starting a dev server, slow for scripts calling `envkit get` in a loop (use `pull --format shell` once instead). This is the main argument for Phase 7's native backend; a cheaper fix is skipping the second `status` call when the cached session was validated recently.
- **The integration suite now takes about 10 minutes** (4 files, each starting its own Vaultwarden, plus slow `bw` calls). Before it grows further, share one server per run through a Vitest `globalSetup`.
- **Not done:** Windows support in `run` (`.cmd` shims need `shell: true` or cross-spawn), and loading a `.env` file _and_ the vault together.

## Phase 4 — Writing secrets ✅

**Goal:** manage variables without opening the Bitwarden UI.

- [x] `envkit set KEY=value [KEY2=value2…] [-e <env>]`: a single bare `KEY` reads the value from stdin (one trailing newline stripped) or from a hidden prompt, so secrets stay out of shell history. Invalid names are refused before anything is written. Prints e.g. `Added PORT; updated API_KEY in "dev".`
- [x] `envkit unset KEY…`: warns about keys that aren't set instead of failing.
- [x] `envkit push [--from .env|-] [-e] [--prune] [--yes]`: bulk import parsed with the `dotenv` package. It previews keys only (`+ NEW`, `~ CHANGED`, `- REMOVED`, `(n unchanged)`) and asks for confirmation. Without a terminal it needs `--yes`. Keys missing from the file are kept unless `--prune` is given.
- [x] `envkit diff <a> [b] [--check]`: compares keys and reports which values differ, never the values themselves. With one name it compares the default environment with it. `--check` exits 1 when a key is missing on either side (for CI).
- [x] **Concurrency (decided):** every write syncs first, whatever the sync interval. Just before saving, `updateItem` fetches the item again and refuses with "This environment changed since envkit read it" if `revisionDate` moved. Vaultwarden's own stale-copy rejection maps to the same error, so a race inside that window is caught too. Nothing is merged automatically; running the command again applies the change on top.
- [x] Writes keep fields envkit doesn't manage (linked fields, invalid names), collapse duplicate names into the first one, keep text fields as text and store new variables as hidden fields.

**Done when:** one user's `set` shows up in another user's `run` after a sync. ✅ In the integration test, Bob `set`s a value and Alice's real `envkit run` prints it after `envkit sync`. It also covers sync-before-write (no lost updates between two writers), `unset`, `push` plus `diff --check`, and a read-only member's failed `set`.

What we learned (and what later phases need to know):

- **Vaultwarden rejects stale writes** with "The client copy of this cipher is out of date…". The revisionDate check is still worth having: it gives a clearer error and catches changes without a round trip that fails.
- **Read-only members** get "You do not have permission to edit this item" from the server. Unlike the collection-create 401, `bw` stays logged in. envkit maps it to "You can only read this environment" with a hint to ask an admin.
- **A member's local copy stays stale until a sync.** Newly granted access, or a teammate's write, is invisible for up to `ENVKIT_SYNC_INTERVAL_MINUTES`. Writes sync anyway; for reads, `envkit sync` is the answer and the hint on "not found" errors says so.
- **The integration suite shares one Vaultwarden** through Vitest `globalSetup` (`project.provide`/`inject`). It still takes about 15 minutes for 5 files because `bw` process startup dominates. Phase 5's CI job should run it on main and nightly rather than on every push, or Phase 7's native backend should replace `bw` in the hot paths.
- **Not done:** renaming variables, and `push` from formats other than dotenv.

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
