---
title: Troubleshooting
description: Diagnose envkit setup, vault connectivity, sessions, and Git coverage.
updated: "2026-11-17"
---

# Troubleshooting

Run these from your project directory:

```bash
envkit doctor
envkit doctor --json
envkit doctor --offline
```

`doctor` checks the selected backend, project configuration, login and lock state,
session storage, HTTPS connectivity, server mismatches, and whether the project's
`.env` is ignored or already tracked by Git. With the `bw` backend it also checks
that the executable meets the minimum supported version.

It never logs in, unlocks, syncs, or reads environment variables. Connectivity uses
an unauthenticated request to the server's `/api/config` endpoint, verifies TLS,
and does not follow redirects. Use `--offline` to skip that request. Config and Git
checks use the nearest `.envkit.json`, including when run from a subdirectory.

Each check reports `pass`, `warn`, `fail`, or `skip`, with a suggested fix where
needed. The exit code is **1** if any check fails, **0** otherwise. Warnings such
as a locked vault, memory-only sessions, a missing project config, or missing Git
ignore rules do not fail the command. A tracked `.env` does fail it.

`--json` prints one object with `ok` and a `checks` array. Each entry contains
`name`, `state`, `message`, and an optional `hint`. Diagnostics do not include
passwords, API keys, session keys, or secret values.

## Common fixes

- **Not logged in:** run `envkit login`. For automatic CI login, set
  `ENVKIT_SERVER` explicitly alongside your credentials.
- **Vault is locked:** run `envkit unlock` when you need secrets.
- **Memory-only sessions:** enable your OS keychain, or supply
  `ENVKIT_PASSWORD` on CI runners.
- **Server mismatch:** check `ENVKIT_SERVER`, `envkit status`, and
  `.envkit.json`. Log out before switching the account's server.
- **Private certificate authority:** set `NODE_EXTRA_CA_CERTS` to the CA
  certificate file before starting envkit.
- **Missing or invalid config:** run `envkit init` or `envkit link <project>`,
  or repair the JSON and required fields.
- **Tracked `.env`:** remove it from Git's index, add it to `.gitignore`, and
  rotate secrets that were committed.

The Git check covers the default `.env` at the project root. If you use another
output path with `envkit pull --out`, make sure that file is ignored too.
Doctor validates local configuration; it does not check whether each linked
environment item still exists in the vault.

## Login verification

Native login supports authenticator and email two-step codes. Integration tests
exercise both against Vaultwarden, including retrying a wrong email code. Codes
are entered through hidden prompts and never stored.

New-device email verification has protocol-level unit tests. Verification against
Bitwarden cloud remains a manual release check. Browser-only methods can use
`envkit login --apikey`, or the Bitwarden CLI backend.
