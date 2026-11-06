# Contributing to envkit

Thanks for helping. Bug reports, fixes, docs and features are all welcome. This guide covers setting up the repo, running the tests and opening a pull request.

## Before you start

- **Bugs:** open an issue with the command you ran, the full output, `envkit --version`, your OS, and the server you use (Bitwarden cloud, self-hosted Bitwarden or Vaultwarden, with its version). Remove secrets, emails and server URLs you don't want public.
- **Features and larger changes:** open an issue first so we can agree on the approach. [`plan.md`](plan.md) lists what's planned and the decisions behind the current design.
- **Security problems:** don't open a public issue. Report them privately through GitHub's [security advisories](https://github.com/bachubila/envkit/security/advisories/new).

## Setup

You need:

- **Node.js 24.7 or newer** (Node 24 LTS).
- **[Vite+](https://viteplus.dev/guide/)**, the `vp` command. It runs the toolchain and installs the pinned pnpm for you. Use pnpm, not npm or yarn: the repo only allows pnpm.
- **Docker**, for the integration tests. The unit tests don't need it.

```bash
git clone https://github.com/bachubila/envkit.git
cd envkit
vp install
```

Run the CLI from source with `pnpm envkit <command>`. To try it against a throwaway server, run `pnpm sandbox`: it starts Vaultwarden in Docker, creates an account and an organization, and prints the variables to export. Ctrl-C deletes it all.

## Repo layout

```
packages/
  core/     # vault backends (native and bw), config, sessions, variables; no CLI code
  cli/      # the `envkit` binary: argument parsing, prompts, output
tools/
  testkit/  # fake vault, Vaultwarden in Docker, integration tests
apps/
  website/  # placeholder for the future docs site
```

`@envkit/core` is bundled into `@envkit/cli`, which is the only published package.

## Checks and tests

| Command                                     | What it runs                                                      |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `vp check`                                  | Format, lint and type check. `vp check --fix` fixes formatting.   |
| `vp run -r test`                            | Unit tests (offline, fast)                                        |
| `vp run ready`                              | All of the above, then the build. CI runs this.                   |
| `vp run test:integration`                   | Integration tests against Vaultwarden in Docker (about 5 minutes) |
| `ENVKIT_BACKEND=bw vp run test:integration` | The same suite through the Bitwarden CLI (about 20 minutes)       |

Run `vp run ready` before every pull request. Run the integration tests when you change anything that talks to the vault. CI runs them on every pull request too, so you can rely on that if you don't have Docker. The `bw` suite only matters when you change `packages/core/src/vault/bw-cli.ts`.

The tests run against Vaultwarden only. If your change affects how envkit talks to the server, say in the pull request whether you also tried it against Bitwarden's cloud.

## Guidelines

- **Security comes first.** envkit handles secrets. Keep plaintext off disk unless the user asks for a file, never put secrets in argv or logs, and verify TLS. Crypto lives in `packages/core/src/vault/native/crypto.ts` and uses only `node:crypto`. Changes there need tests against known values.
- **Match both backends.** The native backend and the `bw` backend implement the same `VaultBackend` interface and should behave the same, errors included. The parity tests in `tools/testkit/tests/native.integration.test.ts` check this.
- **Add a test with every fix,** and check that it fails without the fix.
- **Write error messages that say what to do next.** Use `EnvkitError` with a `hint`.
- **Keep docs current.** Update the README or `docs/` when you change a command, an option or an environment variable.

## Pull requests

1. Fork the repo and branch from `main`.
2. Make your change, with tests.
3. Run `vp run ready`.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for example `fix(native): …`, `feat(cli): …` or `docs: …`.
5. Open the pull request against `main` and describe what changed and why. Link the issue if there is one.

## Releases

Maintainers publish releases. A `v*` tag on `bachubila/envkit` runs `.github/workflows/release.yml`, which publishes to npm under the `next` tag (preview). Stable versions are moved to `latest` by hand. You don't need to bump versions in pull requests.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
