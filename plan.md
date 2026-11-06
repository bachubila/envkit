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
  website/  # existing starter, later becomes the docs site (Phase 8)
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
- [x] CI (`.github/workflows/ci.yml`) runs `vp run ready` on Node 24.7 and the latest 24, then smoke-tests the built binary.

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
- `bw` calls are slow (about 1–3 s each because of Node startup and KDF), and `requireSession` costs two of them before any real work. If this becomes painful, cache the status per run or move to the native backend (Phase 6).
- **Env vars added:** `ENVKIT_HOME`, `ENVKIT_BW_PATH`, `ENVKIT_SERVER`, `ENVKIT_EMAIL`, `ENVKIT_PASSWORD`, `ENVKIT_SESSION`, `ENVKIT_SESSION_IDLE_MINUTES` (plus `BW_CLIENTID` / `BW_CLIENTSECRET`). Phase 5 builds on these.
- **Not verified yet:** the interactive prompts in a real terminal (`@clack/prompts`), `bw`'s 2FA prompts, and the macOS and Windows keychains. Check them by hand before release (Phase 7).

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
- **Latency:** each read costs about 3–4 `bw` processes (status, status with session, maybe sync, get item), so 3–6 s per `envkit run`. That's acceptable for starting a dev server, slow for scripts calling `envkit get` in a loop (use `pull --format shell` once instead). This is the main argument for the native backend (now Phase 6); a cheaper fix is skipping the second `status` call when the cached session was validated recently.
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
- **The integration suite shares one Vaultwarden** through Vitest `globalSetup` (`project.provide`/`inject`). It still takes about 15 minutes for 5 files because `bw` process startup dominates. Phase 5 moved it to main and nightly in CI; the native backend (Phase 6) should replace `bw` in the hot paths.
- **Not done:** renaming variables, and `push` from formats other than dotenv.

## Phase 5 — CI / non-interactive use, and fewer `bw` calls ✅

**Goal:** envkit runs in pipelines without prompts, and each command makes as few `bw` calls as possible.

- [x] **No prompts in CI:** when `CI` is set or `--non-interactive` is passed, envkit never prompts and fails fast with a hint naming the env var to set. `--non-interactive` is a global flag that works before or after the command name. After `--` it belongs to the command `envkit run` starts.
- [x] **Auth from env vars, non-interactive only:** with `BW_CLIENTID` and `BW_CLIENTSECRET`, envkit logs in with the API key and then unlocks with `ENVKIT_PASSWORD`. With `ENVKIT_EMAIL` and `ENVKIT_PASSWORD`, it logs in and unlocks in one step, which only works without two-step login. The server comes from `ENVKIT_SERVER`, else from `.envkit.json`. envkit prints "Logged in as … on …" to stderr. **(Decided)** It never logs in on its own in a terminal, even with these env vars set: a developer's shell may have them exported for something else.
- [x] **Recommended setup documented** in `docs/ci.md`: one CI account per project, with read-only access to only the collections it needs, an API key, and the master password stored as a secret. The doc also has a troubleshooting table.
- [x] **GitHub Actions example workflow** in `docs/ci.md`, running `envkit run --env ci -- vp test`.
- [x] **Masking:** when `GITHUB_ACTIONS=true`, every read sends `::add-mask::` for each value it reads, on stderr, before anything is printed or run. Each line of a multi-line value is masked separately. Values under 4 characters are skipped, because masking `1` or `on` would garble the whole log. `%`, `\r` and `\n` are escaped as GitHub requires.
- [x] **Fewer `bw` calls:**
  - **`bw --version` is cached** in `$ENVKIT_HOME/bw-version.json`, keyed by the real path, size and mtime of the `bw` executable, so upgrading `bw` triggers a new check.
  - **The cached session is trusted without `bw status`.** If `bw` rejects it ("Vault is locked" or "You are not logged in"), envkit falls back once to status, then unlock.
  - **The session store records the last sync**, so the staleness check needs no `bw` call either.
  - `requireSession` now makes one `status` call instead of two.
- [x] **Repo CI:** the integration job runs on pushes to main and nightly, not on pull requests.

**Done when:** a sample GitHub Actions workflow runs `envkit run -- vp test` against a Vaultwarden instance, and `envkit get` makes a single `bw` call with a warm session.

✅ for the single call, partly for the workflow:

- **Single `bw` call.** `packages/cli/tests/ci.test.ts` checks the exact `bw` calls:

  | Case                | `bw` calls                     |
  | ------------------- | ------------------------------ |
  | Warm read           | `get item` only                |
  | Stale copy          | `sync`, `get item`             |
  | Invalidated session | `status`, `unlock`, `get item` |
  | Cold start          | one `status`                   |

- **CI workflow.** `tools/testkit/tests/ci.integration.test.ts` reproduces a fresh GitHub runner against real Vaultwarden and `bw`. The runner has only `.envkit.json`, `CI`, `GITHUB_ACTIONS`, a read-only CI account's API key and its password, and no keychain. On it, `envkit run` logs in, masks the values and runs the command. A second command reuses the login. A missing password fails fast, and a `set` is refused.
- **Not yet verified on GitHub itself.** No workflow in this repo consumes envkit yet, because envkit isn't published (Phase 7). That check happens when the package ships.

What we learned (and what later phases need to know):

- **Measured against real `bw` on a dev machine, under test load:**
  - A warm `get` takes about 5 s end to end.
  - The fallback after an invalidated session takes about 15 s.
  - Before Phase 5, a warm `get` made 4 `bw` calls: version, status, status and get. Now it makes 1.
  - The remaining time is Node startup plus a single `bw` process. Getting from about 1 s to the 100–300 ms target needs Phase 6.
- **`bw sync` works while the vault is locked, but reads don't.** So a write with a dead cached session syncs, fails the read, and only then unlocks. That order is harmless, and the tests pin it.
- **Runners have no keychain**, so envkit uses the in-memory store and each CI step unlocks again (a few seconds). `bw` itself stays logged in for the job. The docs suggest grouping commands into one `envkit run`. Printing a session for `ENVKIT_SESSION` (like `bw unlock --raw`) could come later if multi-step jobs need it.
- **Integration tests must set `ENVKIT_SESSION_STORE=memory`** when they spawn the binary, or the developer's real OS keychain caches sessions and tests leak state into each other.
- **Not verified:** that GitHub masks values sent through `::add-mask::` on **stderr**. Workflow commands are documented for stdout, though the runner reads both. Check this on the first real workflow run, and switch to stdout if it fails (stdout is the child's for `run`, so that means writing before spawning).
- **Build fix:** core's declaration build (tsgo) used to compile the tests too, and wrote `tools/testkit/src/fake-bw.d.ts` on every build. Phase 1 had committed that file by mistake. It's deleted now, and `vp pack` uses `tsconfig.build.json` (src only).

## Phase 6 — Native vault client ✅

Moved ahead of distribution: it decides whether users must install `bw`, which shapes packaging. **Decided: they don't.** The native backend is the default.

- [x] **Native TypeScript backend** (`packages/core/src/vault/native/`) talks to the Vaultwarden API directly. All crypto uses `node:crypto`; the flow is prelogin, KDF, master key, stretched key, user key, RSA private key, organization keys, item.
  - **KDFs:** PBKDF2-SHA256, and Argon2id via `crypto.argon2` on Node 24.7+ (older Nodes get a clear error).
  - **Encrypted strings:** AES-CBC types 0 and 2, and RSA-OAEP types 3 and 4. Per-item cipher keys are supported. The legacy type 0 user key is supported too.
  - **Logins:** password and API key. API-key logins get no refresh token, so the key is stored and used to get new access tokens. A token the server rejects is refreshed and the call retried once. If the refresh fails as well, envkit forgets the login.
- [x] **Local state:** all of it lives in `$ENVKIT_HOME/vault/`, with files at mode 600 written atomically.
  - `state.json` holds the server, device ID, account, tokens and KDF settings, plus the keys still in encrypted form.
  - `vault.json` is the trimmed `/api/sync` response, still encrypted the way the server returns it.
  - Reads need no network: a warm `envkit get` takes **about 110 ms** with the built binary, against about 4 s with `bw`.
- [x] **Sessions:** `unlock` stores the user key encrypted with a fresh random 64-byte session key and returns that key. The session key itself never touches disk; it goes to the keychain or `ENVKIT_SESSION`. A new unlock replaces the wrapped key, which invalidates older sessions, and `lock` deletes it. That matches `bw`, so the Phase 5 fallback logic works unchanged.
- [x] **Parity tests** (`tools/testkit/tests/native.integration.test.ts`) run one vault through both backends:
  - Items `bw` wrote are compared through native, item by item, and the reverse. Native updates a login item and `bw` still sees its username and password.
  - Filters and search, conflict detection and trash all behave the same in both backends.
  - Error messages match, as do the session rules, token refresh, API-key login, file modes and logout.
  - Offline unit tests cover crypto and local reads (`packages/core/tests/native-*.test.ts`).
- [x] **`BwCliBackend` stays as a fallback** behind `ENVKIT_BACKEND=bw`. `createBackend()` picks the backend, and `BwError` became `VaultError` (in `vault/errors.ts`), shared by both. CI runs the integration suite on the native backend for every PR, and on `bw` on main and nightly.

**Done when:** the full integration suite passes with the native backend and `bw` is not installed. ✅ The suite (7 files, 50 tests) passes in about 4.5 minutes, down from about 19. With the native backend, the CLI tests point `ENVKIT_BW_PATH` at a path that doesn't exist, so any command that still spawned `bw` would fail. Only the `bw` backend's own tests and the parity tests run `bw`.

What we learned (and what later phases need to know):

- **Vaultwarden 1.37 requires `encryptedFor`** (the user ID) on cipher create and update. Otherwise it answers with Rocket's generic 422, and only its log names the missing field.
- **The test server needs `LOGIN_RATELIMIT_MAX_BURST` raised.** The native backend logs in fast enough to hit Vaultwarden's default of 10 logins a minute; `bw` was too slow to ever reach it.
- **`bw` reports `revisionDate` at millisecond precision; the server stores microseconds.** The native backend normalizes to `bw`'s format for parity and compares normalized values. `lastKnownRevisionDate` goes to the server unchanged.
- **The `bw` backend returned `undefined` for empty field values,** although `VaultField` says `null`. The parity test caught it, and it's fixed.
- **Responses use mixed casing:** the token response is PascalCase (`Key`, `PrivateKey`, `Kdf`) and the API is camelCase. Errors arrive in `message`, `errorModel.message` or `error_description`.
- **Two-step login is not supported natively.** The backend has no way to prompt, so it points users to API-key login or `ENVKIT_BACKEND=bw`. New-device verification (Vaultwarden with SMTP) would hit the same wall. Both are candidates for Phase 7, which would need a prompt callback in `LoginOptions`.
- **TLS:** Node reads `NODE_EXTRA_CA_CERTS` only at startup. So when the backend's `env` sets it but the process didn't, the backend passes the CA explicitly (in-process tests, embedders).
- **Not done:** pruning the copy when the server deletes items is covered by full syncs only (there's no delta sync), and there's no file locking between concurrent envkit processes. Each state change re-reads `state.json` first, which keeps the race window small; the worst case is one extra unlock.

## Phase 7 — Hardening and distribution

- [x] **Security review** (first pass, 2026-11-05).
  - **Fixed, with regression tests** in `packages/cli/tests/security.test.ts` and `native-crypto.test.ts`:
    - **High: `.envkit.json` decided which item envkit used, unchecked.** The file is committed, so anyone who can push could point a teammate's reads, and their `set`/`push` writes, at an item they control. `env remove --delete` could trash any item the victim could edit. Now `verifyEnvironmentItem` checks the item's organization, collection and envkit notes (project and environment) before every read, write and delete.
    - **Medium: the server chose the KDF settings the native client used for the password hash it sends.** A malicious server could ask for 1 iteration and get a hash that's cheap to crack. envkit now refuses settings below Bitwarden's minimums: PBKDF2 at 100k iterations; Argon2id at 2 iterations, 16 MiB and 1 thread.
    - **Medium: `pull --out` wrote secrets into an existing file before fixing its mode,** and it followed symlinks. It now writes a new 600-mode file and renames it into place.
    - **High: vault values could set `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `PATH`, `BASH_ENV` and similar.** Anyone with write access to an environment could run code on every machine and CI job that does `envkit run`, evals `pull --format shell`, or loads the pulled file with `node --env-file`. Fixed on 2026-11-06: `run` and `pull` leave out the names in `UNSAFE_VARIABLES` and `UNSAFE_PREFIXES` (compared case-insensitively) with a warning. `--allow NAMES` or `ENVKIT_ALLOW_VARIABLES` lets named ones through. The opt-in can't come from `.envkit.json`, which is committed. `set` and `push` warn when writing one. `get NAME` still prints it.
    - **Low: `envkit run` passed `BW_CLIENTID`, `BW_CLIENTSECRET` and `BW_SESSION` to the child.** They're now stripped, as `ENVKIT_PASSWORD` and `ENVKIT_SESSION` already were.
    - **Low: an invalid field name was printed raw in warnings,** so it could carry terminal escape sequences. It's now JSON-quoted.
  - **Checked and fine:**
    - No secret travels in argv. `bw` gets passwords through env vars and items on stdin.
    - TLS is always verified. The client doesn't follow redirects, and URLs must be https.
    - State files are 600 and written atomically. The session key is never written to disk.
    - Variable names are validated before they reach shell or dotenv output, and both formats quote values.
    - GitHub masking runs before any value is printed. There's no value expansion anywhere.
  - **Open (decisions needed):**
    - **Medium: CI auto-login takes the server from the committed `.envkit.json`** when `ENVKIT_SERVER` isn't set. A change to that file in a job that has the secrets would send the API key, or a master password hash, to another server. The KDF minimums keep that hash expensive to crack. Proposal: require `ENVKIT_SERVER` for auto-login, or at least recommend it in `docs/ci.md`.
    - **Low: an API-key login stores the client secret, and a password login the refresh token, in `$ENVKIT_HOME/vault/state.json`** (mode 600), as `bw` does. They could move to the keychain.
    - **Low:** `envkit set KEY=value` leaves the value in shell history; the stdin form is documented in the error hint only. `ENVKIT_SESSION` never idles out. HTTP responses have no size limit.
- [ ] **Two-step login and new-device verification for the native backend.** Now that envkit works against Bitwarden's cloud (see **Bitwarden cloud** below), this matters more. Bitwarden emails a one-time code when an account **without** two-step login logs in from a device it doesn't know. We didn't hit it on the first real logins (2026-11-06), but other accounts will. Today the native backend shows the server's message as `vault: …` and the user's only way out is `ENVKIT_BACKEND=bw`.
  - **Design:** add an optional prompt callback to `LoginOptions` (for example `askCode(kind, hint): Promise<string>`). The CLI implements it with its existing prompt; non-interactive runs (CI) fail with a hint to use `login --apikey`, which skips both checks.
  - **New-device code:** when `/identity/connect/token` refuses the password grant because the device is new, prompt for the emailed code and repeat the same request with the code added (the official clients send it as `newdeviceotp`). Confirm the exact error and field name against bitwarden.eu before coding, and add the case to `toVaultError` so the message is clear even without a prompt.
  - **Two-step login:** the refusal already carries `TwoFactorProviders2` (`hasTwoFactor`). Pick a provider (authenticator app first, then email), prompt, and repeat the request with `twoFactorToken`, `twoFactorProvider` and `twoFactorRemember=0`. Email codes must be requested first (`POST /api/two-factor/send-email-login`). WebAuthn and Duo can't work in a terminal: keep pointing those users to `--apikey`.
  - **Tests:** Vaultwarden supports email two-step login and new-device verification once SMTP is configured, so the integration suite can run both against a mail catcher (for example Mailpit in Docker) and read the code from its API.
  - **Done when:** an account with an authenticator app, and a fresh device on an account without two-step login, can both `envkit login` with the native backend.
- [ ] `envkit doctor`: checks the backend (and the `bw` version with `ENVKIT_BACKEND=bw`), server reachability, login state, config validity and `.gitignore` coverage.
- [x] Integration tests against Vaultwarden in docker (`vaultwarden/server`), run in CI. Done in Phase 1 (`tools/testkit`). Extend them as each phase adds commands.
- [ ] Manual check of interactive prompts, 2FA and the macOS/Windows keychains (see Phase 1 notes).
- [ ] Publish to npm (`npx envkit`, `pnpm dlx envkit`); see **Release 0.1.0** below. Consider single-file binaries later.
- [x] **License: MIT** (decided 2026-11-05). `LICENSE` is at the root and in each package, so tarballs include it.
- [x] Docs: README installation, quickstart, command and env var reference (2026-11-05). **Still to do:** a fuller team setup guide (org roles, collections per environment, offboarding).
- [ ] Versioning and changelog (changesets or similar).

### Release 0.1.0 (preview on the `next` tag)

**Publishing decisions (2026-11-05):**

- **Publish one package, `envkit`, with `@envkit/core` bundled into it.** Core's API isn't meant for others yet, and one package means one version to manage and one thing to install. The `@envkit` npm organization is claimed (owner `bachubila`, 2FA on) to keep the scope. Publish `@envkit/core` only when someone needs the library, and keep it `private: true` until then.
- **Version 0.1.0 on the `next` dist-tag.** `npm i -g envkit@next` gets it, while `npm i envkit` gets nothing until a stable release is tagged `latest`. Move to 1.0.0 once the open issues below are closed and the manual checks are done.
- **Publish with pnpm, never plain `npm publish`.** The manifests use `workspace:` and `catalog:` versions, which only pnpm rewrites. `npm publish` would upload them literally and break installs.
- **The first release is published by hand from a machine with npm 2FA** (`pnpm --filter envkit publish --tag next`, which asks for the one-time code). After that, releases come from GitHub Actions with npm trusted publishing (OIDC, no stored token) and `--provenance`. Configure the trusted publisher for the repo that will make the releases: `ebachubila/envkit` first, then the personal mirror once it takes over (see Repos below).

**Must be done before publishing:**

- [x] **High security issue:** vault values could set `NODE_OPTIONS`, `LD_PRELOAD` and similar. Fixed on 2026-11-06 (see the security review above).
- [x] **The `bw`-backend integration suite has passed** (2026-11-06): `ENVKIT_BACKEND=bw vp run test:integration`, 7 files, 50 tests, in 19m21s. The native backend takes about 4.5 minutes.
- [x] **Bundle core into the CLI** (2026-11-06).
  - `deps.alwaysBundle: ["@envkit/core"]`, bundled from core's TypeScript source (the `source` condition), so a stale core build can't leak in.
  - Core's runtime dependencies are now the CLI's. `@napi-rs/keyring` stays an external dynamic import, because it's native.
  - `@envkit/core` is `private: true`.
- [x] **Package metadata for `envkit`** (2026-11-06).
  - Version 0.1.0, `engines.node >=24.7.0`, keywords.
  - `repository`, `homepage` and `bugs` point at **`github.com/bachubila/envkit`**, the public mirror that will be the package's home. Change them if the public repo ends up elsewhere.
  - `prepack` copies the root README into the package and `postpack` removes it (it's gitignored).
- [x] **Check the tarball** (2026-11-06).
  - `pnpm pack` gives `dist/bin.mjs` (112 kB), `LICENSE`, `README.md` and a `package.json` with real version numbers.
  - Installed globally into a clean prefix (12 packages), it ran `tools/testkit/scripts/smoke-tarball.ts` against a real Vaultwarden: login, init, set, get, list, run, pull and status all passed, and `NODE_OPTIONS` was left out of `run` and `pull`.
- [ ] **CI runs green on GitHub.** Decided on 2026-11-06: the branch is `main` in both repos.
  - `ci.yml` runs check, test, build and the native integration suite on every push and PR, in both repos.
  - `bw-backend.yml` runs the `bw` suite only when the `bw` version, the Vaultwarden image or `bw-cli.ts` changes, plus on demand and before releases. There's no nightly: with pinned versions it would only re-test unchanged code.
  - `release.yml` publishes on a `v*` tag, only in `bachubila/envkit`.
- [ ] **npm side, after the first manual publish:** on npmjs.com → `@envkit/cli` (renamed from `envkit`) → Settings → Trusted publishing, add GitHub Actions with repo `bachubila/envkit`, workflow `release.yml` and environment `npm`. npm only offers this for a package that already exists, so 0.1.0 is published by hand.

**Repos:**

- **`origin`** (`ebachubila/envkit`, private) is where work is pushed and proven first.
- **`origin-public`** (`bachubila/envkit`, tied to the npm account) is the public home, and releases are published from it.

**Release flow:**

1. Push to `origin` and wait for CI to pass.
2. Push the same commit to `origin-public`.
3. Bump `packages/cli/package.json`, then `git tag vX.Y.Z && git push origin-public vX.Y.Z`. `release.yml` runs CI and the `bw` suite, checks that the tag matches the version, then runs `npm publish` with provenance under `next`. Switch it to `latest` at 1.0.

### Bitwarden cloud (0.1.1, 2026-11-06)

The first real use was against **bitwarden.eu**, not Vaultwarden, and it found two problems:

- **Bitwarden's servers reject requests without client headers** ("No client version header found"). Vaultwarden ignores them, so no test caught it. The native backend now sends `Bitwarden-Client-Name: cli`, `Bitwarden-Client-Version` and `Device-Type` on every request (`CLIENT_HEADERS` in `native/backend.ts`, tested in `native-headers.test.ts`). The version has to be recent enough for the server's feature checks: raise it now and then, in step with `bw`.
- **The release workflow's `npm publish` failed with `EBADDEVENGINES`.** npm 11 enforces the root `package.json`'s `devEngines` (pnpm only) in the folder it runs from. The Publish step now runs from `runner.temp`. 0.1.1 itself was published by hand with `pnpm publish`.

After that, login, `list`, `diff` and a second team member reading the shared variables all worked on bitwarden.eu with the native backend. The integration suite still runs only against Vaultwarden: there's no automated test against Bitwarden's cloud.

**Can wait until after 0.1.0:** the Medium and Low items from the security review, `envkit doctor`, two-step login on the native backend, manual macOS/Windows keychain checks, and changesets.

**Done when:** a new team can go from zero to `envkit run` by following the README alone.

## Phase 8 — Later / optional

- [ ] Shell integration: a `direnv`-style hook that loads variables when you `cd` into a project.
- [ ] Editor and runtime integrations (VS Code extension, Vite/Node loaders).
- [ ] Turn `apps/website` into the docs and marketing site.
- [ ] Secret rotation helpers and an audit view (who changed what, from Bitwarden events where available).

---

## Open questions

1. **Minimum `bw` version and Vaultwarden version** we support. The native backend has only been tested against Vaultwarden 1.37.5, and it relies on `encryptedFor`, which older versions may reject or ignore. Tests currently pin `bw` 2026.10.0 and Vaultwarden 1.37.5; `MIN_BW_VERSION` is 2026.1.0 but untested below 2026.10.0. Add a version matrix to the integration job or raise the minimum.
2. **Session storage:** Phase 1 uses the OS keychain and falls back to "prompt every time" when there is none. Confirm that fallback is acceptable, or add an opt-in encrypted file store.
3. ~~**Environment layout default:**~~ Resolved in Phase 2: one collection per project by default; `env add --collection` puts an environment in its own collection.
4. ~~**Package name:**~~ Resolved: `envkit` is free on npm (checked 2026-11-03). The library is `@envkit/core`, so we need to claim the `@envkit` npm scope before publishing.
5. **License.**
