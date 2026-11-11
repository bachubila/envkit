---
title: Configuration
updated: "2026-11-11"
version: "0.1.2"
---

# Configuration

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
