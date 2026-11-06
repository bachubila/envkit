# envkit

**envkit** shares environment variables across a team using the Bitwarden or Vaultwarden vault you already have: Bitwarden's cloud (bitwarden.com or bitwarden.eu), a self-hosted Bitwarden, or Vaultwarden. Each project maps to a collection and each environment (dev, staging, prod) to an item. Access is controlled with your existing organizations and roles. Developers run `envkit run -- npm start` and get the right values; CI gets them from a read-only account with an API key, and they're masked in GitHub Actions logs. envkit talks to the vault directly and keeps an encrypted local copy, so reads take about 100ms and need no Bitwarden CLI.

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

### Configuration

| Variable                         | Purpose                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ENVKIT_SERVER`, `ENVKIT_EMAIL`  | Defaults for `login`                                                                           |
| `ENVKIT_PASSWORD`                | Master password, for unlocking without a prompt (CI); never passed to the commands envkit runs |
| `BW_CLIENTID`, `BW_CLIENTSECRET` | Personal API key, for `login --apikey` and CI                                                  |
| `ENVKIT_SESSION`                 | A session key to use instead of the keychain                                                   |
| `ENVKIT_SYNC_INTERVAL_MINUTES`   | How stale the local copy may get before a read syncs (default 5, 0 = always)                   |
| `ENVKIT_SESSION_IDLE_MINUTES`    | Idle time before the vault locks again (default 60)                                            |
| `ENVKIT_HOME`                    | Where envkit keeps its state (default: your OS config dir)                                     |
| `ENVKIT_ALLOW_VARIABLES`         | Comma-separated variables to pass even though they can make programs run code (see below)      |
| `ENVKIT_BACKEND`                 | `native` (default) or `bw`                                                                     |
| `NODE_EXTRA_CA_CERTS`            | CA certificate for a server with a private CA                                                  |

### Variables envkit leaves out

`envkit run` and `envkit pull` don't pass on variables that make programs load or run code: `PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `BASH_ENV`, `PYTHONPATH`, `JAVA_TOOL_OPTIONS`, `GIT_SSH_COMMAND` and similar. They print a warning for each one instead. Otherwise anyone who can edit an environment could run code on every machine and CI job that uses it.

If you trust everyone with edit access, allow a variable with `--allow NODE_OPTIONS` or `ENVKIT_ALLOW_VARIABLES=NODE_OPTIONS`. This can't be set in `.envkit.json`, because anyone who can push could change that file. `envkit get NODE_OPTIONS` still prints the value.

### CI

Create a read-only CI account with an API key, then run `envkit run -- <your tests>`. In GitHub Actions, values are masked in the logs. See [docs/ci.md](docs/ci.md) for the setup and a sample workflow.

## License

[MIT](LICENSE)

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
vp run -r test
```

- Build the monorepo:

```bash
vp run -r build
```

- Run the development server:

```bash
vp run dev
```
