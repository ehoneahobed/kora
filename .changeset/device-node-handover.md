---
'@korajs/server': patch
---

Automatic device handover after a beta.12 server upgrade (F1). A signed-in device presenting a
node id with history but no owner (beta.12 recorded no node claims), or one an administrator
released, now claims it when the node id equals the device id the auth provider verified for that
user (`metadata.deviceId`, from the token's `dev` claim with `@korajs/auth`). `@korajs/auth` apps
no longer need the bind script: refused devices reconnect and their queued writes upload. The
claim is one atomic store step, the new optional `ServerStore.claimUnownedNode` (SQLite, Postgres
and memory); a node another principal owns is never taken, and another user presenting the node
id is still refused. Logged as `node_claim.handover`; `deviceNodeHandover: false` restores the
beta.13 refusal. The legacy anonymous re-claim uses the same atomic step when the store has it.
