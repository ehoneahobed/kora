---
title: Server-side Validation
description: "Adjudicate untrusted client operations before they become authoritative: accept, reject, or ignore with validateOperation, structured rejections tied to the operation id, and the anonymous-submission quarantine pattern."
---

# Server-side operation validation

The sync server always enforces authentication, server-granted scopes, node ownership, the value
domain, operation size, rate limits and cross-record constraints (see
[Authentication](/guide/authentication)). Beyond that, every operation a client syncs is accepted:
it materializes on the server and fans out to other clients. That is the right default when every
client is one of your own users writing their own data. Add your own policy when a client is
untrusted: a public form, an anonymous submission, a business rule such as an approval workflow.

`validateOperation` lets the server adjudicate each untrusted operation before it
becomes authoritative. You own the policy; the framework owns running it at the
right point and routing its decision so nothing diverges and nothing is lost.

## The hook

Pass `validateOperation` in `syncOptions` (or directly to `KoraSyncServer`). It
runs at sync ingestion, after HLC ordering and the built-in guards (timestamp,
rate, size), and before the operation is materialized. It receives the operation
and `{ auth, kora }`: the session's `AuthContext` (`null` when anonymous) and the
trusted data plane (`kora.findById`, `kora.query`, `kora.apply`,
`kora.applyConditional`), the same one routes get as `request.kora`. With
[schema transforms](/guide/schema-design#devices-on-older-versions-transforms-at-fold-time),
the operation is its view for the server's schema version.

<!-- docs-check-prelude
import { SqliteServerStore } from '@korajs/server'
declare const store: SqliteServerStore
declare const url: string
declare function showRejection(collection: string, recordId: string, message: string): void
-->

```typescript
import { createProductionServer } from '@korajs/server'

const server = createProductionServer({
  store,
  syncOptions: {
    validateOperation: async (op, ctx) => {
      // Anonymous connections have ctx.auth === null.
      if (op.collection === 'submissions') {
        const form = await ctx.kora.findById('forms', (op.data as { formId: string }).formId)
        if (!form || Number(form.closedAt) < Date.now()) {
          return { action: 'reject', code: 'WINDOW_CLOSED', message: 'This form is closed' }
        }
        return { action: 'accept' }
      }
      // Everything else: only the signed-in owner may write.
      if (!ctx.auth) {
        return { action: 'reject', code: 'FORBIDDEN', message: 'Sign in to write' }
      }
      return { action: 'accept' }
    },
  },
})
```

A validator returns one of three decisions:

`accept` lets the operation materialize and relay, exactly as it would with no
validator. `reject` refuses it: the operation never enters the authoritative log,
so no other replica ever sees it, and a structured rejection travels back to the
submitter. `ignore` means the server has taken responsibility out of band (see the
quarantine pattern below) and does not want the raw operation materialized; no
rejection is sent, so the submitter simply drops it from its pending queue.

The `retriable` flag on a rejection defaults from the shared taxonomy for the
code, or you can set it explicitly. Use `true` only for transient conditions
where resubmitting the identical operation might later succeed.

## What the submitter sees

A rejected operation is not silently lost and not retried forever. On the client,
Kora diverts it out of the pending outbound queue into a durable rejected store
and emits a `sync:operation-rejected` event. Since beta.13 the submitter's record
is re-folded without the refused operation, so its view matches the server and every
other device (an inserted record that was refused disappears; a refused edit is
undone, while concurrent accepted edits stay). The operation itself is kept in the
rejected store and the local log, so the app can show the reason and let the user
edit and resubmit. (Writes you discard from a held node with `discardHeld` are not
rolled back: they only stop uploading.)

<!-- docs-check: continue -->
```typescript
import { createApp, defineSchema, t } from 'korajs'

const schema = defineSchema({ version: 1, collections: { submissions: { fields: { formId: t.string() } } } })
const app = createApp({ schema, sync: { url } })

// React to rejections as they happen.
app.on('sync:operation-rejected', (event) => {
  console.warn(event.code, event.message, event.retriable)
})

// Or read the durable list (survives a page refresh) and reconcile.
const rejected = await app.sync?.getRejectedOperations()
for (const r of rejected ?? []) {
  // The write is already undone locally: show the reason and let the user retry.
  showRejection(r.collection, r.recordId, r.message)
  await app.sync?.clearRejectedOperations([r.operationId])
}
```

Convergence holds because the authoritative state is defined purely by accepted
operations. Every device that syncs from the server agrees, without the rejected
op, and so does the submitter once the rejection arrives.

## The quarantine pattern (anonymous submissions)

A public form wants two things at once: the anonymous respondent should see their
own submission, and the form owner should see a clean, validated response, but
the respondent must not see other people's submissions, and the owner must not see
spam. Model it with two collections and a validator that promotes.

Respondents write to a `submissions` collection, scoped so each respondent only
syncs their own. The validator reads the raw submission, and on success authors a
NEW server-side operation into the owner-visible `formResponses` collection, then
ignores the raw one:

<!-- docs-check: skip a validateOperation option shown out of its server config -->
```typescript
validateOperation: async (op, ctx) => {
  if (op.collection !== 'submissions') return { action: 'accept' }

  const data = op.data as { formId: string; answers: unknown }
  const form = await ctx.kora.findById('forms', data.formId)
  if (!form || Number(form.closedAt) < Date.now()) {
    return { action: 'reject', code: 'WINDOW_CLOSED', message: 'This form is closed' }
  }

  // Author a derived, owner-visible response as a trusted server op. Never mutate
  // the incoming op. A new op keeps content-addressing and convergence intact.
  await ctx.kora.apply({
    collection: 'formResponses',
    type: 'insert',
    data: { formId: data.formId, answers: data.answers },
  })

  // The server has taken responsibility; the raw submission need not materialize.
  return { action: 'ignore' }
}
```

The owner subscribes to `formResponses` and sees validated responses only. A
respondent never sees another respondent's data because the derivation runs on the
trusted server, not on any client. And because the derived op is authored fresh
rather than by mutating the submission, replay and convergence are unaffected.
