---
title: Introduction
updated: "2026-11-11"
version: "0.1.2"
---

# Introduction

**envkit** shares environment variables across a team using the Bitwarden or Vaultwarden vault you already have: Bitwarden's cloud (bitwarden.com or bitwarden.eu), a self-hosted Bitwarden, or Vaultwarden. Each project maps to a collection and each environment (dev, staging, prod) to an item. Access is controlled with your existing organizations and roles. Developers run `envkit run -- npm start` and get the right values; CI gets them from a read-only account with an API key, and they're masked in GitHub Actions logs. envkit talks to the vault directly and keeps an encrypted local copy, so reads take about 100ms and need no Bitwarden CLI.

[Get started →](./getting-started.md)
