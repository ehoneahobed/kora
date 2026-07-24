---
title: Server-side Validation
description: "Adjudicate untrusted client operations before they become authoritative: accept, reject, or ignore with validateOperation, structured rejections tied to the operation id, and the anonymous-submission quarantine pattern."
---

# Server-side operation validation

By default every operation a client syncs is trusted: it materializes on the
server and fans out to other clients. That is the right default when every client
is one of your own users writing their own data. It is the wrong default the
moment a client is untrusted: a public form, an anonymous submission, a
multi-tenant boundary where one tenant must not be able to write another's data.

`validateOperation` lets the server adjudicate each untrusted operation before it
becomes authoritative. You own the policy; the framework owns running it at the
right point and routing its decision so nothing diverges and nothing is lost.

## The hook

Pass `validateOperation` in `syncOptions` (or directly to `KoraSyncServer`). It
runs at sync ingestion, after HLC ordering and the built-in guards (timestamp,
rate, size), and before the operation is materialized.

```typescript
import { createProductionServer } from '@korajs/server'

const server = createProductionServer({
  store,
  syncOptions: {
    validateOperation: async (op, ctx) => {
      // Anonymous connections have ctx.auth === null.
      if (op.collection === 'submissions') {
        const form = await ctx.kora.findById('forms', (op.data as { formId: string }).formId)
        if (!form || form.closedAt < Date.now()) {
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
and emits a `sync:operation-rejected` event. The submitter's own optimistic local
write is left in place; the framework surfaces the rejection rather than deciding
for you whether to roll it back or let the user edit and resubmit.

```typescript
const app = createApp({ schema, sync: { url } })

// React to rejections as they happen.
app.sync?.subscribeStatus(() => {}) // status also reflects the drop in pending count

// Or read the durable list (survives a page refresh) and reconcile.
const rejected = await app.sync?.getRejectedOperations()
for (const r of rejected ?? []) {
  // Roll the optimistic write back, or show the reason and let the user retry.
  await app[r.collection].delete(r.recordId)
  await app.sync?.clearRejectedOperations([r.operationId])
}
```

Convergence holds because the authoritative state is defined purely by accepted
operations. Every device that syncs from the server agrees, without the rejected
op. The submitter is the only place the rejected write exists, and it is told, so
it can reconcile instead of diverging silently.

## The quarantine pattern (anonymous submissions)

A public form wants two things at once: the anonymous respondent should see their
own submission, and the form owner should see a clean, validated response, but
the respondent must not see other people's submissions, and the owner must not see
spam. Model it with two collections and a validator that promotes.

Respondents write to a `submissions` collection, scoped so each respondent only
syncs their own. The validator reads the raw submission, and on success authors a
NEW server-side operation into the owner-visible `formResponses` collection, then
ignores the raw one:

```typescript
validateOperation: async (op, ctx) => {
  if (op.collection !== 'submissions') return { action: 'accept' }

  const data = op.data as { formId: string; answers: unknown }
  const form = await ctx.kora.findById('forms', data.formId)
  if (!form || form.closedAt < Date.now()) {
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
