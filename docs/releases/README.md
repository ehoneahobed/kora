---
title: Release Milestones
description: "Kora.js release milestones and the exit criteria each version must meet before it ships."
---

# Release milestones

| Version | Doc | Gate command |
|---------|-----|----------------|
| v0.5 internal beta | [v0.5-internal-beta.md](./v0.5-internal-beta.md) | `pnpm test:release-gate` |
| v0.6 public beta | [v0.6-public-beta.md](./v0.6-public-beta.md) | `pnpm test:release-gate` + `pnpm test:e2e` |
| 1.0.0-beta.11 | [v1.0.0-beta.11.md](./v1.0.0-beta.11.md) | `pnpm test:pre-release` + publish dry-run |
| 1.0.0-beta.12 | [v1.0.0-beta.12.md](./v1.0.0-beta.12.md) | `pnpm test:pre-release` + publish dry-run |
| npm publish beta.12 | [npm-publish-checklist-beta.12.md](./npm-publish-checklist-beta.12.md) | maintainer authentication required |
| 1.0.0-beta.13 (security release) | [v1.0.0-beta.13.md](./v1.0.0-beta.13.md), [security advisory](./security-advisory-beta13.md) | `pnpm test:pre-release` + `pnpm release:dry-run` |
| 1.0.0-beta.14 (draft) | [v1.0.0-beta.14.md](./v1.0.0-beta.14.md) | `pnpm test:pre-release` + `pnpm release:dry-run` |
| npm publish beta.13 | [npm-publish-checklist-beta.13.md](./npm-publish-checklist-beta.13.md) | publish to npm, then go public, then the advisory |
| npm publish beta.11 and the normal Changesets flow | [npm-publish-checklist.md](./npm-publish-checklist.md) | `pnpm release:dry-run` |

Implementation tracking: the best-in-class implementation plan (retired; all 92 items complete) (complete).
