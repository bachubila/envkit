---
title: Getting started
updated: "2026-11-11"
version: "0.1.2"
---

# Getting started

## Installation

You need:

- **Node.js 24.7 or newer (Node 24 LTS).**
- **A Bitwarden-compatible vault reachable over https,** with an organization for your team. Bitwarden's cloud (`https://vault.bitwarden.com` or `https://vault.bitwarden.eu`) and Vaultwarden both work. The automated tests run against Vaultwarden.

```bash
npm install --global @envkit/cli
```

Or run it without installing: `npx @envkit/cli <command>`.

Releases go out on two npm tags:

- **`latest`** (the default) is the stable release, for everyday use.
- **`next`** is the preview channel: alpha and beta builds that get new features and fixes first and may change. Install it with `npm install --global @envkit/cli@next`.

To build it from source, clone this repo, run `vp install && vp run -r build`, and use `node packages/cli/dist/bin.mjs`.

The Bitwarden CLI is **not** required. envkit talks to the server itself. To use `bw` instead, install `@bitwarden/cli` and set `ENVKIT_BACKEND=bw`.

Interactive native login supports authenticator codes, email two-step codes, and new-device email verification. Authenticator login is tested against Vaultwarden; the email flows still need real-server verification. CI and accounts using browser-only methods should use `envkit login --apikey` with `BW_CLIENTID` and `BW_CLIENTSECRET` (see [CI setup](./ci.md)).

## Quickstart

### 1. Set up a project (once, by an organization owner or admin)

```bash
envkit login --server https://vault.example.com --email you@example.com
cd my-app
envkit init --project my-app --env dev,prod   # creates the collection and one item per environment
envkit push --from .env                       # upload your existing .env to "dev"
envkit set -e prod DATABASE_URL               # or set values one by one (prompts, out of shell history)
git add .envkit.json && git commit -m "Use envkit"
```

`init` writes `.envkit.json`. It holds only IDs, no secrets, and is meant to be committed. Then give teammates access to the `my-app` collection in the web vault (_Organization → Collections → my-app → Access_). Read-only access is enough for anyone who only needs to run the app.

### 2. Use it (every teammate)

```bash
git clone … && cd my-app
envkit login --server https://vault.example.com --email teammate@example.com
envkit run -- npm start                # the command gets dev's variables
envkit run -e prod -- npm run migrate  # another environment
```

The vault stays unlocked for 60 idle minutes, using your OS keychain.

### Everyday commands

| Command                                        | What it does                                                  |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `envkit run [-e env] -- <cmd>`                 | Run a command with the environment's variables                |
| `envkit get KEY`                               | Print one value, e.g. `$(envkit get API_KEY)`                 |
| `envkit list [--reveal]`                       | List variable names (values masked)                           |
| `envkit pull [--out .env] [--format json]`     | Print the variables, or write them to a mode-600 file         |
| `envkit set KEY=value` / `envkit set KEY`      | Add or change values (the second form reads stdin or prompts) |
| `envkit unset KEY`                             | Remove variables                                              |
| `envkit push [--from file] [--prune]`          | Upload a .env file, showing the changes first                 |
| `envkit diff dev prod`                         | Compare the variable names of two environments                |
| `envkit env list / add / remove`               | Manage environments                                           |
| `envkit sync`                                  | Fetch teammates' changes now (otherwise every 5 minutes)      |
| `envkit status` / `lock` / `unlock` / `logout` | Session management                                            |

Run `envkit <command> --help` for every option.
