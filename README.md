# envkit

**envkit** shares environment variables across a team using the Vaultwarden (Bitwarden-compatible) server you already host. Each project maps to a collection and each environment (dev, staging, prod) to an item. Access is controlled with your existing organizations and roles. Developers run `envkit run -- npm start` and get the right values; CI gets them from a read-only account with an API key, and they're masked in GitHub Actions logs. envkit talks to the vault directly and keeps an encrypted local copy, so reads take about 100ms and need no Bitwarden CLI.

See [docs/ci.md](docs/ci.md) for using envkit in CI.

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
