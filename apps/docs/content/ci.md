---
title: CI setup
updated: "2026-11-11"
version: "0.1.2"
---

# Using envkit in CI

envkit runs without prompts in pipelines. When `CI` is set, or you pass `--non-interactive`, it never asks for anything. If it needs input it fails with an error that names the env var to set.

## Recommended setup

1. **Create one vault account per project for CI**, e.g. `ci-myapp@example.com`. Don't reuse a person's account: you'd have to store their master password in CI.
2. **Invite it to the organization and give it read-only access** (_Can view_) to only the collections it needs. Usually that's one environment, such as `myapp` → `ci` or `staging`. envkit refuses to write with read-only access, so a pipeline can't change values.
3. **Create an API key for it.** In the web vault, log in as the CI account and open _Account settings → Security → Keys → View API key_. That gives you `client_id` (`user.…`) and `client_secret`.
4. **Store three secrets in your CI**: `BW_CLIENTID`, `BW_CLIENTSECRET` and `ENVKIT_PASSWORD` (the CI account's master password). The master password is what decrypts the vault; the API key only logs in.

On the first envkit command, envkit:

- logs in with the API key,
- unlocks the vault with `ENVKIT_PASSWORD`,
- takes the server URL from the committed `.envkit.json`, or from `ENVKIT_SERVER` if you set it.

envkit never passes `ENVKIT_PASSWORD` or `ENVKIT_SESSION` to the commands it runs.

Instead of the API key, you can set `ENVKIT_EMAIL` with `ENVKIT_PASSWORD`. That works only when the account has no two-step login, so prefer the API key.

## GitHub Actions

```yaml
name: test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      BW_CLIENTID: ${{ secrets.BW_CLIENTID }}
      BW_CLIENTSECRET: ${{ secrets.BW_CLIENTSECRET }}
      ENVKIT_PASSWORD: ${{ secrets.ENVKIT_PASSWORD }}
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: voidzero-dev/setup-vp@v1.21.2
        with:
          node-version: "24"
          cache: true
      - run: npm install --global @envkit/cli
      - run: envkit run --env ci -- vp test
```

**Masking.** Inside GitHub Actions (when `GITHUB_ACTIONS=true`), envkit first sends an `::add-mask::` command for every value it reads, and only then prints anything or starts the command. GitHub then shows those values as `***` in the job log, even when your tests print them.

Two limits on masking:

- Values shorter than 4 characters are not masked, because masking every `1` or `on` would make logs unreadable.
- A multi-line value is masked line by line.

**Several steps.** envkit stays logged in for the whole job, but there's no keychain on a runner, so each envkit step unlocks the vault again. That costs well under a second per step with the default backend. Put the commands that need secrets in one `envkit run` step where you can, e.g. `envkit run -- sh -c "vp test && vp run e2e"`.

## Other CI systems

The setup is the same anywhere: install Node.js 24.7 or newer (Node 24 LTS) and envkit, set the three secrets as env vars, and set `CI=true` if your CI doesn't. Only the masking is GitHub-specific, so check that your CI hides secret values in its logs.

## The Bitwarden CLI backend

envkit talks to the vault itself and doesn't need the Bitwarden CLI. If you set `ENVKIT_BACKEND=bw`, it drives `bw` instead. Then install `@bitwarden/cli` 2026.1.0 or newer, and expect each command to take a few seconds.

## Troubleshooting

| Error                                | Fix                                                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Not logged in`                      | Set `BW_CLIENTID` and `BW_CLIENTSECRET` (or `ENVKIT_EMAIL`), and commit `.envkit.json` or set `ENVKIT_SERVER` so envkit knows the server. |
| `Vault is locked`                    | Set `ENVKIT_PASSWORD`.                                                                                                                    |
| Self-signed certificate              | Set `NODE_EXTRA_CA_CERTS` to the CA certificate's path.                                                                                   |
| `You can only read this environment` | This is expected for a read-only CI account. Writes belong on a developer machine.                                                        |
