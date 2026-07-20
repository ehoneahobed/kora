---
title: Release Milestones
description: "Kora.js release milestones and the exit criteria each version must meet before it ships."
---

# Release milestones

| Version | Doc | Gate command |
|---------|-----|----------------|
| v0.5 internal beta | [v0.5-internal-beta.md](./v0.5-internal-beta.md) | `pnpm test:release-gate` |
| v0.6 public beta | [v0.6-public-beta.md](./v0.6-public-beta.md) | `pnpm test:release-gate` + `pnpm test:e2e` |
| npm publish (maintainers) | [npm-publish-checklist.md](./npm-publish-checklist.md) | `pnpm changeset publish --dry-run` |

Implementation tracking: the best-in-class implementation plan (retired; all 92 items complete) (complete).
