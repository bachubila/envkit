# envkit documentation

Run from the repository root:

```bash
vp run docs#dev
vp run docs#build
vp run docs#preview
```

Write pages in `apps/docs/content/`. Edit `site.json` for the site title,
description, public hostname, navigation, and sidebar links. Add each new page
to the sidebar to make it discoverable.

Page metadata lives in YAML frontmatter:

```yaml
---
title: Installation
description: Install envkit
updated: "2026-11-11"
version: "0.1.2"
---
```

The theme displays `updated` and `version` above the page. These values are
maintained by the author; version metadata does not create release snapshots.
VitePress also shows the last update from Git history when it is available.

## Publishing

Configure a static host to install from the repository root with `vp install`,
build with `vp run docs#build`, and publish `apps/docs/.vitepress/dist`.
Attach `docs.envkit.dev` to that deployment and apply the DNS records supplied
by your hosting provider. The sitemap already uses that hostname.

This app requires no server or database. Pushing Markdown changes can trigger
a rebuild through your hosting provider's Git integration.

### Vercel

Set the Vercel project's **Root Directory** to `apps/docs` and enable
**Include source files outside of the Root Directory in the Build Step**
so the workspace configuration and lockfile are available.

The checked-in `vercel.json` installs workspace dependencies with the pinned
pnpm version, runs the app's build script, and publishes `.vitepress/dist`.
It includes development dependencies because VitePress is a build tool.
The host does not need a global Vite+ installation.

Do not use `vitepress build docs`: this app's VitePress root is `apps/docs`
itself, and its Markdown folder is configured in `.vitepress/config.ts`.
Attach `docs.envkit.dev` in the project's Domains settings.
