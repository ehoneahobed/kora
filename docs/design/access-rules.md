# Design: access rules (membership-derived grants)

Status: PROPOSAL for 1.0.0-beta.15, under review. Internal design doc (not published).
Workstream B of the beta.15 plan. Nothing here is implemented yet.

## 1. Problem

Every multi-user app built on Kora needs the same thing: a user sees and edits records because
of who they are (the owner) or which groups they belong to (a shared document, a course, a
branch, a clinic team), and that access changes while devices are offline. Three apps built it
by hand, with the same workarounds:

- koraforms (design) and koradocs (design) encode membership as a list of space ids in the
  grant (`spaceId: { $in: [...] }`), "re-key" a document's records from `user:<owner>` to
  `doc:<id>` the first time it is shared, cap shared items at the `$in` limit, wrap the auth
  provider to compute grants from membership tables, and nudge `refreshScopes` after every
  membership change.
- The LMS runs its own `server-scopes.ts` in production for the same purpose.

The workarounds exist because of four limits of today's model (inventory, section 10):

1. A scope predicate compares a record's own fields to values the auth provider lists, with
   equality and `$in` joined by AND. "Owner OR member" cannot be said; membership must be
   flattened into an `$in` list (100 values by default).
2. A grant comes from the auth provider. Kora does not know where it came from, so it cannot
   tell which sessions a membership change affects.
3. A changed grant ends the session (`SCOPE_CHANGED`); the client reconnects and, when the
   view widened, downloads its whole scope again from sequence 0.
4. There is no way to declare that only the server writes a collection (memberships,
   invitations); apps approximate it with `validateOperation`.

These parts sit on the trust boundary. The beta.14 advisory (GHSA-5678-ff89-65pj) was a bug in
exactly this area. They should be written, tested and red-teamed once, in the framework.

## 2. Goals and non-goals

Goals:

- Declare read and write access per collection in the schema, from owner fields and
  memberships, with roles.
- Memberships are server-owned rows. A change to them applies to live sessions at a precise
  point in the delivery order, on every server instance, without reconnecting and without
  re-downloading what the device already has.
- No practical ceiling on how many groups a user belongs to (thousands), and no re-keying.
- Every existing guarantee holds: gap-free delivery, history judged on the record as it was
  (RT-14), scope entry and retraction, stored-row authorization of writes, presence, rich
  text and blob access all decide on the same rules.
- Opt-in and incremental: collections without `access` keep today's behavior exactly.

Non-goals (beta.15):

- Group hierarchies (a team inside a department inside an org), social graphs, and rules that
  follow more than one relation. The `custom` escape hatch and today's provider grants remain.
- End-to-end encrypted rule evaluation (the server must see the fields rules read).
- Product features (invitations, emails, member-list UI). They belong to the optional
  `@korajs/spaces` kit built on this engine.

## 3. Developer experience

```typescript
import { defineSchema, t, owner, member, anyone, serverOnly, or } from 'korajs'

export default defineSchema({
  version: 4,
  access: {
    // Server-owned membership rows: who belongs to which group, with which role.
    memberships: 'members',
    // A document is a group; its owner joins it as 'manage' when the server takes in the insert.
    groups: { documents: { owner: 'ownerId', role: 'manage' } },
    roles: ['view', 'comment', 'edit', 'manage'],
  },
  collections: {
    members: {
      fields: { userId: t.string(), groupId: t.string(), role: t.string(), expiresAt: t.timestamp().optional() },
      access: { read: member('groupId'), write: serverOnly() },
    },
    documents: {
      fields: { title: t.string(), body: t.richtext(), ownerId: t.string(), status: t.enum(['draft', 'published']) },
      access: {
        read: member('id'),
        create: owner('ownerId'),
        update: member('id', ['edit', 'manage']),
        delete: member('id', ['manage']),
      },
    },
    comments: {
      fields: { documentId: t.string(), body: t.string(), authorId: t.string() },
      access: {
        read: member('documentId'),
        write: member('documentId', ['comment', 'edit', 'manage']),
      },
    },
    templates: { fields: { name: t.string() }, access: { read: anyone(), write: serverOnly() } },
  },
})
```

Server: nothing to wire. With `access` in the schema, the sync server derives every signed-in
session's grant from it. Changing access is a write:

```typescript
await server.kora.apply({ collection: 'members', type: 'insert', recordId, data: { userId, groupId: docId, role: 'edit' } })
// Every live session of userId, on every instance, now receives the document and its comments.
```

Client: unchanged. `useQuery(app.documents.where({}))` returns what the user may read; a write
the user may not make is refused locally (`OUT_OF_UPLINK_SCOPE`) when the device knows it, and
by the server otherwise.

### 3.1 Rule vocabulary

| Rule | Meaning for user `u` and record `r` |
|---|---|
| `owner('f')` | `r.f === u.id` |
| `member('f', roles?)` | `u` has a live membership in group `r.f` (with one of `roles`, when given) |
| `where({ f: value })` | `r.f` equals `value` (equality on the record, for example `status: 'published'`) |
| `anyone()` | always, including anonymous sessions |
| `serverOnly()` | never from a client (server writes only) |
| `or(a, b, ...)`, `and(a, b, ...)` | combinations |
| `custom(fn)` | server-side `(record, user) => boolean`; escape hatch, see 7.4 |

`write` is shorthand for `create`, `update` and `delete`. A collection with `access` but no
`read` is readable by no client. Writes are judged on the stored row and on the resulting row,
as today (a client cannot move a record out of its own reach; transfers go through the server).

### 3.2 Fit across app types

| App | Rules |
|---|---|
| Docs, forms | `read: member('id')` on the item; `member('itemId')` on children |
| LMS | submissions: `read: or(owner('learnerId'), member('courseId', ['instructor']))`, `write: owner('learnerId')`; lessons: `read: member('courseId')` |
| POS | `read: member('branchId')`; prices: `update: member('branchId', ['manager'])` |
| Clinical | `read: member('clinicId')` plus time-limited memberships (`expiresAt`) for consent; `custom` for anything else |
| Personal | `read: owner('userId'), write: owner('userId')` |
| Field collection | assignments as memberships: `read: member('formId')` |

## 4. Model

### 4.1 Memberships and the membership index

- The collection named by `access.memberships` holds `{ userId, groupId, role, expiresAt? }`
  (field names configurable). It is implicitly `write: serverOnly()`: client writes are refused
  with `SERVER_OWNED`.
- The server keeps an index `_kora_access_memberships(user_id, group_id, role, expires_at,
  delivery_seq)` maintained in the same transaction as the membership operation's
  materialization (SQLite, Postgres, memory stores). It answers "groups of user u" and
  "users of group g" in one indexed read.
- Derived groups (`access.groups`): when the server takes in an insert of a group collection
  (`documents`), it writes the owner's membership row as a server operation in the same
  transaction, so the owner can read children (`member('documentId')`) of a document created
  offline as soon as it syncs. The device that created it already has it locally.
- Expiry: a membership past `expiresAt` is not live. The server schedules a re-scope for the
  affected sessions at expiry (section 5).

### 4.2 Compiling rules into grants

For each session, the engine compiles the rules with the user's memberships into a grant in
the existing predicate form, extended with OR (section 4.3):

```
documents.read  = member('id')                    -> { id: { $in: [groups of u] } }
submissions.read = or(owner('learnerId'), member('courseId', ['instructor']))
                 -> { $or: [ { learnerId: u }, { courseId: { $in: [instructor groups of u] } } ] }
```

Because the output is the predicate form every subsystem already uses, delivery visibility,
scope snapshots (RT-14), scope entry, retraction, uplink authorization, reference checks,
presence, the Yjs doc channel, blob access and the route context all decide on the same rules
without new code paths. The compiled grant goes to the client at handshake, as today, for local
pre-checks and narrowing.

`custom` rules compile to a server-side predicate object that the shared matcher calls; clients
treat it as "unknown" (no local refusal; the server decides).

### 4.3 Predicate language extension

- `$or: [conjunction, ...]` per collection (disjunctive normal form, at most 8 branches).
  Each conjunction is today's form (equality and `$in`, AND across fields).
- Large `$in` lists: matching is already Set-based for frozen lists of 32 or more. The value
  limit for engine-compiled grants is the membership count, with a configurable ceiling
  (default 10,000), since the list never travels in a token and is read from the index.
- Scope snapshots must capture every field any rule reads (they already keep scalars; rule
  fields that are not scalar are refused by `defineSchema`).
- `scopeViewKey` covers the compiled grant, so delivery watermarks stay per view.
- Query subsets stay equality-only (unchanged).

Protocol: additive. A client that does not understand `$or` (beta.14) is refused at handshake
with `CLIENT_TOO_OLD` when the server's schema has `access`; apps without `access` are
unaffected.

## 5. Live re-scoping without reconnecting

Today a changed grant ends the session and the client downloads its whole view again. The
engine instead applies a grant change inside the session, at a precise delivery sequence.

1. A membership operation for user `u` is committed with delivery sequence `S`.
2. Every session of `u`, on every instance, meets that operation in its own delivery stream
   (the store is shared; no pub/sub is needed). Membership operations are delivered to the
   member's sessions even when the member cannot read the `members` row of others.
3. At `S`, the session recomputes its grant from the index as of `S` and computes the delta:
   - Groups gained: the records now readable that were not (`read(new) AND NOT read(old)`),
     read from materialized state, are sent as scope-entry inserts (current values, field
     versions and fold state; the same mechanism as RT-19), sharing sequence `S`. History from
     before entry is not disclosed (RT-14 semantics).
   - Groups lost: the records readable before and not now are sent as retractions at `S`.
   - The new grant (downlink and uplink) is sent to the client in the same batch, so its local
     pre-checks and narrowing switch at exactly `S`.
4. The client applies entries, retractions and the new grant atomically with the batch and
   advances its watermark past `S` only after all of it is durable (law L3).
5. Delivery continues from `S` with the new grant. Nothing before `S` is re-sent.

Properties to prove (tests, section 8):

- No operation of a lost group with delivery sequence greater than `S` reaches the session.
- Every record of a gained group is on the device after the batch at `S`, with state equal to
  a fresh device's state for the same grant.
- A crash or disconnect between steps resumes from the client's watermark: the batch at `S` is
  re-generated identically (deterministic from the index as of `S`).
- Several membership changes in one chunk are applied in sequence order.

Large deltas (joining a group with 100,000 records) are streamed in chunks that all carry `S`
as their base and end with the batch that advances past `S`, using the existing one-batch
lookahead and backpressure.

Unsent offline edits to a lost group: refused on the device (`SCOPE_RETRACTED`, existing
`sync:scope-retracted`), kept in the rejected-operations store, and offered for export by the
app (the kit provides "download your unsent edits"). Payloads stay in the user's local
operation log; product copy says "removed from your workspace", not "deleted from your device".

`refreshScopes` remains for provider-derived grants; it is unnecessary for access rules.

## 6. Composition with today's grants

- Collections with `access` get their grant from the engine. Collections without `access`
  keep the provider's grant (`scopes`, `downlinkScopes`, `uplinkScopes`, claims bindings).
- A provider may add grants to `access` collections for special principals (public share
  links in koradocs): `AuthContext.extraGrants`, ORed with the engine's grant. Removing an
  extra grant still uses `refreshScopes`.
- Anonymous sessions: only `anyone()` and `extraGrants` apply.
- `unscopedSharing` (F4) treats a schema with `access` on every synced collection as scoped.

## 7. Security model

### 7.1 Trust

The server is the only judge (unchanged). Rules are evaluated on stored rows and memberships
the server owns. The compiled grant on the client is a cache for offline pre-checks, never
authority.

### 7.2 Writes

- Insert: `create` on the resulting row. Update: `update` on the stored row AND the resulting
  row. Delete: `delete` on the stored row. Today's `authorizeUplinkWrite` already has this
  shape; rules extend it with roles.
- A write that changes a field a rule reads (`ownerId`, `documentId`, `courseId`) must satisfy
  the rule before and after: moving a record between groups needs membership in both with the
  required role, or a server route.
- Membership and derived-group writes are server-only (`SERVER_OWNED`).

### 7.3 Reads and side channels

Presence, Yjs relay, blob reads and route `query` with a session scope all use the compiled
grant through the shared matcher (single implementation). The delivery-row isolation from
beta.14 applies unchanged: the engine's index reads are per decision, never cached on the
session across passes.

### 7.4 `custom`

Runs on the server only, on the stored row, for reads (per record, cost noted) and writes.
It cannot be indexed and is not known to clients. Documented as the escape hatch, with a
warning that it is slower and must be pure and deterministic.

### 7.5 Review

Codex review and an independent red-team pass on this document before code, then on the
implementation; the external security review (beta.15 plan) includes the engine.

## 8. Test plan

- Property: for random schemas, memberships and operation histories, the server's delivery
  equals a reference evaluator that replays rules from scratch at every sequence.
- Re-scope: join and leave mid-stream, many changes in one chunk, crash between steps, two
  instances sharing a Postgres store (each sees the change at the same `S`), expiry.
- Writes: role escalation attempts, moving records between groups, stale client grant offline
  for days, derived-group owner membership for a document created offline.
- Side channels: presence, Yjs, blob read and peer forwarding, route `query` with a session
  scope, all denied after `S` for a lost group.
- Scale: 10,000 memberships per user, 1,000 groups gained at once (streamed), delivery cost
  with the visibility index (C2).
- The apps: koradocs isolation (D1 to D10) and koraforms sharing expressed as `access` rules;
  the LMS `server-scopes.ts` rules expressed as `access` with identical delivery on its fixture.

## 9. Rollout and effort

| Step | Days |
|---|---|
| Predicate `$or`, matcher, snapshots, view key (core, server, sync) | 3 to 4 |
| `access` schema, validation, rule compiler, `serverOnly` | 3 |
| Membership index, derived groups, expiry (three stores) | 3 to 4 |
| Live re-scoping at `S` (server and client), streaming deltas | 6 to 8 |
| Roles in write authorization, `extraGrants`, `custom` | 2 |
| Tests (property, chaos with membership churn, scale), red team fixes | 5 |
| Docs, upgrade guide, examples | 2 |
| `@korajs/spaces` kit (invitations, roles UI hooks, unsent-edits export) | 4 to 5 |

About 6 weeks. Order: predicate language and compiler, index, writes, re-scoping, kit.

## 10. Today's machinery this builds on (inventory, 2026-10-08)

- Schema: `scope` and `sync.where` bind fields to claims (`core/scopes/sync-scope-bindings.ts`);
  no access or server-only concepts (`core/schema/define.ts:77-86`).
- Grants: `resolveSessionScopeGrant` (`server/scopes/resolve-session-scopes.ts:119-175`),
  `computeSessionScopes` (`server/session/client-session.ts:2618-2711`).
- Predicates: equality and `$in`, AND only (`sync/scopes/scope-snapshot.ts:61-123`); limit 100,
  configurable (`server/scopes/server-scope-filter.ts:15`).
- Delivery: snapshots (RT-14), scope entry (RT-19), retraction (RT-15) in
  `client-session.ts:3682-3872`, `4142-4213`.
- Writes: `authorizeUplinkWrite` on stored and resulting rows (`server-scope-filter.ts:308-348`),
  reference checks, `validateOperation`.
- Grant changes: `refreshScopes` and revalidation end the session with `SCOPE_CHANGED`
  (`client-session.ts:1338-1444`); no cross-instance mechanism.
- Client retraction hides rows and refuses unsent edits (`sync-engine.ts:3601-3637`,
  `outbound-queue.ts:390-404`); narrowing scans every collection (`store.ts:1595-1631`).
- Gaps found: built-in `@korajs/auth` grants cannot be directional; RBAC's `__readonly` is not
  understood by the sync server; org routes do not refresh grants.

## 11. Open questions for review

1. Should derived groups support more than one owner field, or is "owner joins as role X"
   enough?
2. `$or` branch limit (8): enough for real apps?
3. Should membership rows of others be readable by default (`member('groupId')`) or only
   one's own (`owner('userId')`)? Proposed: the app decides; the kit defaults to members
   seeing the member list.
4. Should `CLIENT_TOO_OLD` be avoidable by compiling to AND-only grants when no rule needs OR?
   Proposed: yes, only grants that need `$or` require a beta.15 client.
