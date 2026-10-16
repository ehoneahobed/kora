---
title: Access Rules
description: "Declare who may read and write each record in the schema: owners, group memberships with roles, and public data. The sync server enforces it, and every device follows membership changes live, offline work included."
---

# Access Rules

Access rules say, in the schema, who may read and write each record: its owner, the members of a group it belongs to (a document, a board, a course), everyone, or only the server. The sync server enforces them on every upload and on every download, and each device follows membership changes as they happen: a user added to a document receives it, a user removed loses it, without reconnecting and without any sync code in the app.

::: info Clients and server on the same release
Access rules need Kora 1.0.0-beta.15 or later on both sides. An older client is refused at its handshake (`CLIENT_TOO_OLD`) and asked to upgrade.
:::

## A schema with access rules

<!-- docs-check-prelude
import { and, defineSchema, member, memberOfKey, or, owner, serverOnly, anyone, t } from 'korajs'
-->

```typescript
import { and, anyone, defineSchema, member, memberOfKey, or, owner, serverOnly, t } from 'korajs'

export const schema = defineSchema({
  version: 1,
  access: {
    // The collection that holds memberships (userId, group, role).
    memberships: 'members',
    // Lowest to highest: member('documentId', 'comment') also admits edit and manage.
    roles: ['view', 'comment', 'edit', 'manage'],
    // A document is a group. Its creator becomes a member with role 'manage'.
    groups: { documents: { owner: 'ownerId', role: 'manage' } },
  },
  collections: {
    members: {
      fields: {
        userId: t.string(),
        group: t.string(),
        role: t.string(),
        expiresAt: t.timestamp().optional(),
      },
      // Members of a group see its member list. Writes: the server only (no write rule).
      access: { read: memberOfKey('group') },
    },
    documents: {
      fields: { title: t.string(), ownerId: t.string().stamp('userId') },
      access: {
        read: member('id'), // the document is its own group
        create: owner('ownerId'),
        update: member('id', 'edit'),
        delete: member('id', 'manage'),
      },
    },
    comments: {
      fields: { documentId: t.string(), body: t.string(), authorId: t.string().stamp('userId') },
      access: {
        read: member('documentId', 'view', { group: 'documents' }),
        create: member('documentId', 'comment', { group: 'documents' }),
        update: and(owner('authorId'), member('documentId', 'comment', { group: 'documents' })),
        delete: or(owner('authorId'), member('documentId', 'manage', { group: 'documents' })),
      },
    },
    templates: {
      fields: { name: t.string() },
      access: { read: anyone(), write: serverOnly() },
    },
  },
})
```

A collection without `access` keeps the grant your auth provider gives it. In a collection with `access`, a rule you leave out denies every client: `members` above has no write rule, so only the server writes memberships.

### Rules

| Rule | Holds when |
|---|---|
| `owner('field')` | The record's `field` is the signed-in user's id. |
| `member('field', minRole?, { group? })` | The user is a member, with at least `minRole`, of the group the record's `field` names. `member('id')` makes the record its own group. |
| `memberOfKey('field', minRole?)` | The record's `field` holds a group key (`documents:<id>`) the user is a member of. Used for the memberships collection. |
| `where({ field: value })` | Every listed field equals its value (`where({ status: 'published' })`). |
| `anyone()` | Always, anonymous sessions included. A write rule needs `anyone({ writes: true })`. |
| `serverOnly()` | Never from a client. |
| `or(...)`, `and(...)` | Any one, or every one, of the rules holds. |
| `custom(fn)` | Write rules only: a pure, synchronous function of the record, the user and their memberships. |

`write` is shorthand for `create`, `update` and `delete`. `fields: { grade: { write: member('courseId', 'instructor', { group: 'courses' }) } }` adds a rule for writing one field on top of the collection's.

A read rule compiles to a filter the server applies to the download stream, which is why `custom()` is not allowed there. It may expand to at most 8 alternatives (`or` adds, `and` multiplies).

### Owner fields: `stamp('userId')`

`t.string().stamp('userId')` marks a field that always holds the user who created the record. On insert Kora fills it with the signed-in user, so the app leaves it out; naming another user throws `StampedFieldError` (`STAMP_MISMATCH`), and the server refuses it too. The device must know who is signed in: use `sync.authClient` (see [Authentication](/guide/authentication)). Inserting before that, without passing the field, throws `STAMP_USER_UNKNOWN`.

Fields that decide access (an owner field, a field a `member()` rule reads) cannot be changed by clients. Move records between owners or groups from the server.

### Groups

A group is any string key; `access.groups` makes the records of a collection into groups (`documents:<id>`) and makes their creator a member with the configured role while they own the record. A client cannot create a group record with an id that already exists (`GROUP_EXISTS`).

A new member receives the group's current state when they join, and its changes from then on, never the operations written before they joined. A member removed and added again receives the current state again.

## The server

<!-- docs-check-prelude
import { defineSchema, member, owner, t } from 'korajs'
declare const schema: ReturnType<typeof defineSchema>
declare const auth: import('@korajs/server').AuthProvider
-->

```typescript
import { createProductionServer, createSqliteServerStore } from '@korajs/server'

const store = createSqliteServerStore({ filename: './kora-server.db' })
await store.setSchema(schema)

const server = createProductionServer({
  store,
  syncOptions: { schemaVersion: schema.version, auth },
  httpRoutes: [
    {
      path: '/api/invitations/accept',
      async handle(request) {
        const { userId, documentId } = request.body as { userId: string; documentId: string }
        // Check the invitation here, then:
        const result = await request.access.grant({
          userId,
          group: ['documents', documentId],
          role: 'edit',
        })
        return { status: result.ok ? 200 : 400, body: result }
      },
    },
  ],
})
await server.start()
```

Rules about who the user is (`owner()`, `member()`, `memberOfKey()`, and the membership API) need an auth provider; `anyone()`, `where()` and `serverOnly()` work for anonymous sessions too. Nothing turns enforcement on: a schema that declares `access` is enforced. The built-in stores (memory, SQLite, Postgres) keep the membership index the rules are judged against; a custom store must implement `getMembershipIntervals` and `getAccessIndexState`, or the server refuses to start (`ACCESS_RULES_UNSUPPORTED_STORE`) rather than serve the collections unchecked. The `experimentalAccessRules` option of the beta.15 canaries is no longer needed and only logs a deprecation warning.

### Changing who belongs where

Every change is an ordinary server write, so it is in the log, reaches every instance and every device, and takes effect for authorization at once:

```typescript
import type { AccessApi } from '@korajs/server'
declare const access: AccessApi

await access.grant({ userId: 'u2', group: ['documents', 'd1'], role: 'edit' })
await access.grant({ userId: 'u3', group: ['documents', 'd1'], role: 'view', expiresAt: Date.now() + 86_400_000 })
await access.revoke({ userId: 'u2', group: ['documents', 'd1'] })
await access.transfer({ group: ['documents', 'd1'], toUserId: 'u3' })
```

`access.roleOf(userId, group)` returns `{ role, source, since, proof }` (or null): the highest role from the group record's owner field and the user's live memberships. `proof` changes whenever that role changes, ends or is granted again, and whenever the index is rebuilt (a replace-mode restore, a deploy that indexes a collection anew), so storing it is proof the role held (check it again inside `kora.transaction` with `tx.roleOf`). Store `proof`, not `since`: a rebuild reuses sequences. Every `server.access` write runs as a transaction, so a grant, a revoke and a transfer of the same membership never interleave. Inside your own `kora.transaction`, `access.prepareGrant(tx, input)` and `access.prepareRevoke(tx, input)` return the membership writes to commit together with the rest (an invitation accepted and its membership granted as one step).

`server.access` is the same API for background jobs, and custom routes get it as `request.access`. Granting an existing membership changes its role or expiry. Expiry needs an `expiresAt` field on the memberships collection; the server ends expired memberships every minute (`accessSweepIntervalMs`), and authorization treats them as ended from the moment they expire.

For people inviting people (email invitations, roles, leaving, transferring), use [`@korajs/spaces`](/guide/sharing), which builds those routes on this API.

## What devices see

- **Membership changes arrive live.** A grant sends the group's records to every connected device of that user; a revoke removes them. A device that was offline catches up when it reconnects, from where it left off, including records that moved or were deleted while it was away.
- **A deleted group grants its members nothing.** Deleting a group record (a document, a form) ends every membership of it at once, so its members' devices drop what they could read through it and their writes to it are refused. The owner keeps it (they can still restore it), and a write that revives the record gives its members their access back.
- **Rule changes too.** After a deploy that changes read rules, each device is brought in line once at its next connection: it drops what the new rules deny and receives what they now allow.
- **`useQuery` shows what the user may read.** Removed records leave the device's queries; the `sync:scope-retracted` event names each one.

### Offline work

- A group created offline (a new document, with comments in it) syncs as is: the device keeps it while the server catches up, and the creator becomes its owner.
- An edit made offline to a record the user has since lost is kept on the device and uploaded; the server decides it. If the server refuses it, the record is removed and the edit is reported through `sync:operation-rejected` and `app.sync.getRejectedOperations()`, so the app can offer to export it. Nothing is deleted silently.

### Refusals

| Code | Meaning |
|---|---|
| `ACCESS_DENIED` | The write rule does not hold for this user and record. |
| `SERVER_OWNED` | The collection or field has no client write rule. |
| `IMMUTABLE_ACCESS_FIELD` | A client tried to change a field that decides access. |
| `GROUP_EXISTS` | A client insert reused the id of an existing group record. |
| `STAMP_REQUIRED`, `STAMP_MISMATCH` | A stamped field was missing or named another user. |

## Adopting access rules in an existing app

Write each user's memberships (rows of the memberships collection) and make sure group records have their owner field set before you deploy the schema with `access`. When the server first installs it, it builds its membership index from the existing records, and existing members keep the history they could already see.

If your app already keeps who-may-see-what elsewhere (a collaborators table, an enrollment list), derive the memberships from it with `backfill` after the server starts. It is safe to run at every startup: a membership that already holds the same role and expiry is left alone, so a second run writes nothing.

```typescript
import type { AccessApi, ProductionHttpRouteContext } from '@korajs/server'
declare const access: AccessApi
declare const kora: ProductionHttpRouteContext

const rows = await kora.query('collaborators', { where: { status: 'accepted' } })
const result = await access.backfill(
  rows.map((row) => ({ userId: String(row.userId), group: ['forms', String(row.formId)] as const, role: String(row.role) })),
)
// { granted, unchanged, missingGroups, failed }
```

Invalid input (an unknown role, an empty user id) throws before anything is written. A membership whose group record no longer exists is skipped and listed in `missingGroups`. Backfilled members are granted from that point: their devices receive each group's current records, then its changes.

## Current limits

- The device does not check write rules before sending; the server decides, and the device learns refusals as above.
- A read-rule deploy sends each device everything it may read once, which is a large download for big accounts.
- A replace-mode backup restore rebuilds the index from the restored records, so the server cannot tell what each device held before: every device is re-scoped in full at its next connection (it drops what it may no longer read and is sent everything it may), like after a read-rule deploy. A merge-mode import adds operations like any upload and changes nothing here.
- While the server rebuilds its membership index (`setSchema` with access rules, a replace-mode restore on any instance), sessions are refused with a retriable `ACCESS_RULES_CHANGED` and reconnect once it is ready. Sessions that started before a rebuild (a restore, a newly indexed collection), or before the schema declared access rules, are ended the same way, at their next message or the next delivery poll, and reconnect under the current index. Changing transforms (`setOperationTransforms`) does the same while records are re-folded. A rebuild that fails part-way (a schema install, a transform re-fold, a restore after replacing the log) leaves access rules out of force until one succeeds, and `roleOf` throws a retriable `ACCESS_INDEX_NOT_READY` meanwhile.
