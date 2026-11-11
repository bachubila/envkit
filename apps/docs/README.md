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
