---
title: "Security advisory: stale record used to authorize live rich-text updates (fixed in 1.0.0-beta.14)"
---

# Stale record used to authorize live rich-text updates

**Severity:** Low (`CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:L/A:N`, 3.1) · **Affected:** `@korajs/server`
`<= 1.0.0-beta.13` · **Patched:** `1.0.0-beta.14` · **CWE:** CWE-367, CWE-863 · **GitHub advisory:**
[GHSA-5678-ff89-65pj](https://github.com/ehoneahobed/kora/security/advisories/GHSA-5678-ff89-65pj)

## Summary

While the sync server delivered a batch of operations to a session, it cached the records it read
for that batch on the session object. Other checks that ran on the same session during the batch
reused that cache instead of reading the stored record. One of them authorizes live rich-text
(Yjs) document updates. A user whose access to a record was removed (the record moved out of
their scope) could, during that short window, have a live Yjs update authorized against the old
row and relayed to the devices of the record's new owner. Upload reference checks and presence
could also use such a row.

## Impact

Only deployments that move records between users' scopes or remove collaborators, and that use
rich-text (Yjs) document channels, are affected. The window is the duration of one delivery
batch, the attacker must already hold an authenticated session that had access to the record,
and the injected update is a live edit (it is not persisted as an operation by the server).
No confidentiality impact.

## Patches

Upgrade every `korajs` and `@korajs/*` package to `1.0.0-beta.14`, sync servers first.

```bash
pnpm add korajs@1.0.0-beta.14 @korajs/server@1.0.0-beta.14   # plus every other @korajs/* package you use
```

The rows a delivery pass reads are now passed down that pass only; every other check reads the
stored record. Regression test: `packages/server/tests/integration/delivery-row-isolation.test.ts`.

## Workarounds

Disable rich-text document channels, or avoid moving records out of a user's scope while that
user has a live session, until you upgrade.

## Credits

Found during review of the 1.0.0-beta.14 presence changes.
