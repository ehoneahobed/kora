---
title: Release Milestones
description: "Kora.js release milestones and the exit criteria each version must meet before it ships."
---

# Release milestones

| Version | Doc | Gate command |
|---------|-----|----------------|
| 1.0.0-beta.11 | [v1.0.0-beta.11.md](./v1.0.0-beta.11.md) | `pnpm test:pre-release` + publish dry-run |
| 1.0.0-beta.12 | [v1.0.0-beta.12.md](./v1.0.0-beta.12.md) | `pnpm test:pre-release` + publish dry-run |
| 1.0.0-beta.13 (security release) | [v1.0.0-beta.13.md](./v1.0.0-beta.13.md), [security advisory](./security-advisory-beta13.md) | `pnpm test:pre-release` + `pnpm release:dry-run` |
| 1.0.0-beta.14 (draft) | [v1.0.0-beta.14.md](./v1.0.0-beta.14.md) | `pnpm test:pre-release` + `pnpm release:dry-run` |
| 1.0.0-beta.15 (draft) | [v1.0.0-beta.15.md](./v1.0.0-beta.15.md) | `pnpm test:pre-release` + `pnpm release:dry-run` |
| npm publish beta.13 | [npm-publish-checklist-beta.13.md](./npm-publish-checklist-beta.13.md) | publish to npm, then go public, then the advisory |
| npm publish beta.11 and the normal Changesets flow | [npm-publish-checklist.md](./npm-publish-checklist.md) | `pnpm release:dry-run` |
