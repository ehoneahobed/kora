# Design: access rules (membership-derived grants)

Status: PROPOSAL for 1.0.0-beta.15, revision 2 (after an independent red-team review; changes
listed in section 12). Internal design doc (not published). Workstream B of the beta.15 plan.
Nothing here is implemented yet.

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

The workarounds exist because of four limits of today's model (inventory, section 11):

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
  memberships, with ordered roles and field-level write rules.
- Memberships are server-owned rows. Authorization (writes, rich text, presence, blobs, routes)
  always uses the memberships as they are at the moment of the decision. The download stream
  re-scopes at a precise delivery sequence, on every server instance, without reconnecting and
  without re-downloading what the device already has.
- Offline work is never lost to the rules: a document created offline, edited and commented on
  before the first sync, syncs completely.
- No practical ceiling on how many groups a user belongs to (thousands), and no re-keying.
- Every existing guarantee holds: gap-free delivery, history judged on the record as it was
  (RT-14), scope entry and retraction, stored-row authorization of writes.
- Opt-in and incremental: collections without `access` keep today's behavior exactly.

Non-goals (beta.15):

- Group hierarchies, social graphs, rules that follow more than one relation.
- End-to-end encrypted rule evaluation (the server must see the fields rules read).
- Sharing while offline: memberships are written by the server, so inviting needs a connection.
- Product features (invitations, emails, member-list UI). They belong to the optional
  `@korajs/spaces` kit built on this engine.

## 3. Developer experience

```typescript
import { defineSchema, t, owner, member, anyone, serverOnly, or, and } from 'korajs'

export default defineSchema({
  version: 4,
  access: {
    memberships: 'members',
    // Ordered lowest to highest: member('f', 'comment') admits comment, edit and manage.
    roles: ['view', 'comment', 'edit', 'manage'],
    // A document is a group. Its creator joins it as 'manage' when the server takes in the
    // first insert. Group ids are namespaced by collection (documents:<id>).
    groups: { documents: { owner: 'ownerId', role: 'manage' } },
  },
  collections: {
    members: {
      fields: { userId: t.string(), group: t.string(), role: t.string(), expiresAt: t.timestamp().optional() },
      access: { read: member('group') },            // writes: server only, implicitly
    },
    documents: {
      fields: { title: t.string(), body: t.richtext(), ownerId: t.string().stamp('userId'), status: t.enum(['draft', 'published']) },
      access: {
        read: member('id'),                          // the document is its own group
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
        update: and(member('documentId', 'comment', { group: 'documents' }), owner('authorId')),
        delete: or(owner('authorId'), member('documentId', 'manage', { group: 'documents' })),
      },
    },
    submissions: {
      fields: { courseId: t.string(), learnerId: t.string().stamp('userId'), answer: t.string(), grade: t.number().optional() },
      access: {
        read: or(owner('learnerId'), member('courseId', 'instructor', { group: 'courses' })),
        create: and(owner('learnerId'), member('courseId', 'learner', { group: 'courses' })),
        update: owner('learnerId'),
        fields: { grade: { update: member('courseId', 'instructor', { group: 'courses' }) } },
      },
    },
    templates: { fields: { name: t.string() }, access: { read: anyone(), write: serverOnly() } },
  },
})
```

Server: nothing to wire. With `access` in the schema, the sync server derives every signed-in
session's grant from it. Changing access is a server write:

```typescript
await server.access.grant({ userId, group: ['documents', docId], role: 'edit' })
await server.access.revoke({ userId, group: ['documents', docId] })
// Every live session of userId, on every instance, gains or loses the document and its
// comments; authorization uses the change at once, the download stream at its sequence.
```

Client: unchanged. `useQuery(app.documents.where({}))` returns what the user may read; a write
the user may not make is refused locally when the device knows it, by the server otherwise.

### 3.1 Rule vocabulary

| Rule | Meaning for user `u` and record `r` |
|---|---|
| `owner('f')` | `r.f === u.id` |
| `member('f', minRole?, { group? })` | `u` has a live membership in group `<group>:<r.f>` with at least `minRole`. `group` defaults to the collection itself for `member('id')`, otherwise to the collection a declared relation on `f` points at; ambiguous cases are a schema error. |
| `where({ f: value })` | `r.f` equals `value` |
| `anyone()` | always, including anonymous sessions. Allowed in `read` only; `write: anyone()` needs `anyone({ writes: true })`. |
| `serverOnly()` | never from a client |
| `or(...)`, `and(...)` | combinations |
| `custom(fn)` | server-side escape hatch, section 7.4 |

`write` is shorthand for `create`, `update` and `delete`. `fields` adds field-level `update`
rules (a change to that field needs that rule; other fields still need the collection rule
unless the field rule is the only one the write needs). `t.string().stamp('userId')` makes the
server set the field to the writing user on insert and refuse a client value that differs.

A collection with `access` but no `read` is readable by no client. A deny is represented by
leaving the collection out of the compiled grant, never by an empty predicate (`{}` means
"everything" in today's matcher).

### 3.2 Fit across app types

| App | Rules |
|---|---|
| Docs, forms | `read: member('id')` on the item; `member('itemId', ..., { group })` on children |
| LMS | as in the example: learners own submissions, instructors grade a single field |
| POS | `read: member('branchId')`; price changes `member('branchId', 'manager')` |
| Clinical | `member('clinicId')`; consent as time-limited memberships (`expiresAt`), with an optional grace period for offline notes; break-glass as a short membership granted by an audited route |
| Personal | `read: owner('userId'), write: owner('userId')` |
| Field collection | assignments as memberships: `read: member('formId', 'enumerator', { group: 'forms' })` |

## 4. Model

### 4.1 Groups and memberships

- A group is `(collection, id)`, written `documents:<id>`. Namespacing removes cross-collection
  confusion (a document whose id equals a course id grants nothing on the course).
- The memberships collection holds `{ userId, group, role, expiresAt? }`. Its `userId` and
  `group` are immutable; `role` and `expiresAt` change. It is written only by the server
  (`server.access.*`, routes, the kit); client writes are refused with `SERVER_OWNED`.
- The server keeps `_kora_access_memberships(user_id, group_key, role, expires_at, joined_seq,
  left_seq)` maintained in the same transaction as the membership operation, through a new
  store API for derived writes inside the ingest transaction (memory, SQLite, Postgres), with
  crash recovery modeled on `resumeStoredDeleteEffects`. `joined_seq` and `left_seq` are the
  delivery sequences of the join and the leave, which gives the history the download stream
  needs (section 5.3). Re-joining appends a new row.

### 4.2 Derived groups (no re-keying)

When the server takes in a client insert into a group collection (`documents`):

- The record must not exist, live or deleted: a client insert onto an existing record id in a
  group collection is refused (`GROUP_EXISTS`). This closes "insert with the victim's id".
- The owner field must equal the writing user (enforced by `stamp('userId')` and checked again).
- The server writes the owner's membership (`manage`) as a derived write in the same
  transaction, with `joined_seq` equal to the insert's delivery sequence.
- A group record's id and owner field are immutable for clients. Ownership transfer is a
  server route.

Deleting a group record keeps its memberships (a restore brings the group back); the rows of a
deleted group are hidden by the rules as today.

### 4.3 Compiling rules

For each decision, rules are evaluated against the record and the user's memberships. For the
download stream and the client's local pre-checks, rules are compiled per session into the
predicate form, extended with OR:

```
documents.read   -> { id: { $in: [document groups of u] } }
submissions.read -> { $or: [ { learnerId: u }, { courseId: { $in: [course groups where u >= instructor] } } ] }
```

`$or` is a structural type in the grant, not a key in the field map, and every consumer goes
through one matcher (section 6.2 lists them). Compiled grants are sent to the client as a
diff from the version it holds, never the full list on every change.

## 5. Two clocks: authorization now, delivery at S

### 5.1 Authorization reads the memberships at decision time

Every authorization decision reads the membership index at that moment: uploads (inside the
store's apply critical section, as `authorizeUplinkWrite` runs today), Yjs relay in both
directions, presence, blob reads and peer forwarding, and route `query` or `apply` with a
session scope. Point lookups (`user, group`) are indexed and cached per session only until the
next membership operation for that user is committed on any instance (a per-user version read
with the decision). A removed user cannot keep access by stalling their download stream.

### 5.2 The download stream re-scopes at the membership operation's sequence S

1. A membership change for user `u` is committed with delivery sequence `S`.
2. Every session of `u`, on every instance, meets that operation in its delivery stream (the
   store is shared). `filterDeliveryChunk` splits a scan chunk at membership operations, so
   each part is judged under the grant in force for it.
3. At `S`, the session computes the delta with the index as it is when the session processes
   `S` (which is at least as recent as `S`):
   - gained groups: records now readable that were not, sent as scope-entry inserts with
     current values, field versions and fold state (RT-19);
   - lost groups: retractions;
   - the grant diff for the client.
4. These travel as one re-scope unit at `S`: a sequence of batches with base `S` and a final
   batch that advances past `S`. The client persists entries, retractions and the new grant
   version, and advances its watermark past `S` only after the whole unit is durable (law L3).
   A unit interrupted by a crash or disconnect is re-sent from the client's watermark; it may
   differ from the first attempt if memberships changed again, which is safe because the
   content is always "what this grant may read now" and later changes are themselves later
   sequences. Tests assert convergence, not byte equality.
5. Delivery continues past `S` under the new grant.

The membership operation at `S` itself is judged under the new grant. A user's own membership
row is delivered before the retraction of the group's other membership rows.

### 5.3 History before joining is not disclosed, on any path

A member receives a group's state at the moment they joined, never its earlier history.
During delivery, an operation of group `g` with delivery sequence below the member's
`joined_seq` for `g` is not delivered; at `joined_seq` the member receives scope entries. This
holds for a live session, a reconnect and a fresh device replaying from 0, which today's model
does not guarantee (a fresh device of a member receives a group's whole history). Clinical
consent windows and redacted documents depend on it.

### 5.4 Reconnecting after membership changes

The view identity of an engine grant is stable: a fingerprint of the rules, the user id and the
query subsets, not the grant's content. Watermarks therefore survive membership changes. At
handshake the client reports its watermark and the grant version it holds; the server emits a
re-scope unit for the difference at the resume point, then streams from the watermark. A device
that was offline while it gained or lost groups catches up without a full re-download.

### 5.5 Offline work is never lost to the rules

- The client treats the groups of its own pending group-record inserts as granted
  (`documents:<id>` with role `manage` for a document it created and has not synced), so local
  pre-checks pass for the document's edits and comments.
- Handshake narrowing and retraction skip records that have pending local operations; those
  are decided by the server when they upload.
- The server authorizes each operation of an uploaded batch against the live index after the
  earlier operations of the batch, including their derived memberships, are committed.
- Edits to a group the user really lost are refused (`SCOPE_RETRACTED`), kept in the rejected
  operations store and offered for export ("download your unsent edits" in the kit). Product
  copy says "removed from your workspace", not "deleted from your device".

### 5.6 Expiry

Expiry gets a real sequence: a server sweeper writes the expiry as a membership operation, and
authorization also checks `expiresAt` against server time at decision time. `expiryGraceMs`
(default 0) accepts offline writes made before expiry and uploaded within the grace period,
judged by the operation's timestamp; documented as a policy choice.

## 6. Composition and implementation surface

### 6.1 With today's grants

- Collections with `access` get their grant from the engine; collections without `access`
  keep the provider's grant, unchanged.
- `AuthContext.extraGrants: { read?, write? }` adds provider grants to `access` collections
  for special principals (koradocs public share links), directional and read-only unless
  `write` is set. Adding or removing one still uses `refreshScopes`.
- Anonymous sessions: only `anyone()` and `extraGrants`.
- A schema with `access` requires beta.15 clients: older clients are refused at handshake with
  `CLIENT_TOO_OLD` (re-scope units, grant diffs and long lists are new).

### 6.2 Consumers that move to the one matcher

`operationMatchesScopes`, `recordMatchesScopes`, `missingScopeFields`,
`snapshotLacksScopeFields`, `snapshotValuesWithFallback`, `snapshotEntersScopes`,
`snapshotExitsScopes`, `splitScopeForQuery`, `authorizeUplinkWrite`, `authorizeRecordWrite`,
reference authorization (RT-22), cascade checks, `prefetchRecordsFor`, presence
(`canReceiveRecord`, partition keys), the blob access index, the route context, the client's
`operationMatchesScope`, uplink pre-check and `applyScopeNarrowing` (which becomes an indexed
query per affected collection instead of a full scan). Each gets `$or` and deny tests.

### 6.3 Per-type and field-level write grants

Today one upload predicate covers every write type and also decides reference reachability
(RT-22) and cascades. The engine splits it into create, update, delete and field rules, and
defines reference reachability as "the parent is readable" (read rule), cascades as "the
cascading write is allowed by the child's delete or update rule". This is a real change to
`authorizeUplinkWrite`, not an extension.

## 7. Security model

### 7.1 Trust

The server is the only judge. Rules are evaluated on stored rows and on memberships the server
owns. The client's compiled grant is a cache for offline pre-checks, never authority.

### 7.2 Writes

- Insert: `create` on the resulting row, plus the stored-row check of today (an insert onto an
  existing record is an update for authorization, and is refused in group collections).
- Update: `update` on the stored row and on the resulting row, and every changed field's field
  rule.
- Delete: `delete` on the stored row.
- Fields a rule reads (`ownerId`, `documentId`, `courseId`, membership `userId` and `group`)
  are immutable for clients by default (`IMMUTABLE_ACCESS_FIELD`); moving records between
  groups or owners is a server route. This closes "keep access through another branch of an
  `or()`".
- Stamped fields (`stamp('userId')`) cannot be spoofed.

### 7.3 Reads and side channels

All decided at decision time (5.1) through the one matcher. The delivery-row isolation from
beta.14 applies unchanged.

### 7.4 `custom`

Pure over `(record, user, memberships)`, server only. It cannot be pushed down to SQL or
diffed incrementally: a collection with a `custom` read rule is re-evaluated in full on a
re-scope (documented cost) and is excluded from client pre-checks. It may not depend on
anything else (time, other records), because nothing would tell sessions when its answer
changes.

### 7.5 Review

This revision addresses the first independent red-team review (section 12). A second review of
this document, then Codex and an independent pass on the implementation; the external security
review (beta.15 plan) includes the engine.

## 8. Test plan

- Property: for random schemas, memberships and histories, the server's delivered state for a
  user equals a reference evaluator's (records readable under the final grant, with no
  operation of a group delivered below the user's `joined_seq` or above their `left_seq`).
- Adversarial: stalled download stream while removed (uploads, Yjs, presence, blobs refused at
  once); insert with an existing or deleted group id; owner field spoofing; `or()` branch
  rewrite; membership field rewrite; role escalation; empty grants (deny, never "everything").
- Offline: document created, edited and commented on offline, then synced in one batch;
  narrowing with pending local operations; revoked while offline for days; expiry with and
  without grace.
- Re-scope: join and leave mid-stream, several changes in one chunk, crash inside a re-scope
  unit, reconnect after changes while offline (no full re-download), two instances on one
  Postgres store.
- History: fresh device of a member who joined late receives no earlier history.
- Scale: 10,000 memberships per user, 1,000 groups gained at once (streamed), grant diffs.
- The apps: koradocs isolation (D1 to D10) and koraforms sharing expressed as `access` rules;
  the LMS `server-scopes.ts` rules expressed as `access` on its fixture.

## 9. Rollout and effort

| Step | Days |
|---|---|
| Structural `$or`, deny representation, one matcher across every consumer (core, server, sync) | 5 to 6 |
| `access` schema, validation, ordered roles, field rules, `stamp`, compiler, `serverOnly` | 4 |
| Membership index with join and leave sequences, derived writes in the ingest transaction (three stores), derived groups, expiry sweeper | 6 to 7 |
| Authorization at decision time across uploads, Yjs, presence, blobs, routes; per-type write grants | 4 to 5 |
| Download re-scope units at S, history gating, stable view identity, reconnect deltas, client side | 8 to 10 |
| Offline-created groups on the client, narrowing with pending operations | 2 to 3 |
| Tests (property, adversarial, chaos with membership churn, scale) and second-review fixes | 6 |
| Docs, upgrade guide, examples | 2 |
| `@korajs/spaces` kit | 4 to 5 |

About 9 to 10 weeks of work. This is larger than the beta.15 plan assumed (5 weeks); see the
plan's decision on scope.

## 10. Open questions for review

1. Is "a member receives no history before joining" the right default for every app, or should
   a group opt into full history for new members (a team wiki might want it)?
2. `expiryGraceMs` default: 0 (strict) or a few hours (offline-friendly)?
3. Should the kit default to members seeing the member list (`read: member('group')`)?
4. `$or` branch limit (proposed 8): enough?

## 11. Today's machinery this builds on (inventory, 2026-10-08)

- Schema: `scope` and `sync.where` bind fields to claims (`core/scopes/sync-scope-bindings.ts`);
  no access or server-only concepts (`core/schema/define.ts:77-86`).
- Grants: `resolveSessionScopeGrant` (`server/scopes/resolve-session-scopes.ts:119-175`),
  `computeSessionScopes` (`server/session/client-session.ts:2618-2711`).
- Predicates: equality and `$in`, AND only (`sync/scopes/scope-snapshot.ts:61-123`); limit 100,
  configurable (`server/scopes/server-scope-filter.ts:15`); `{}` means unrestricted
  (`server-scope-filter.ts:101`, `327`).
- Delivery: snapshots (RT-14), scope entry (RT-19), retraction (RT-15) in
  `client-session.ts:3682-3872`, `4142-4213`; one grant per scan chunk; view key restart from 0
  (`client-session.ts:2341-2350`, `sync-engine.ts:1563-1571`).
- Writes: `authorizeUplinkWrite` on stored and resulting rows (`server-scope-filter.ts:308-348`),
  reference checks (`reference-authorization.ts:85-91`), `validateOperation`; side effects after
  commit (`apply-server-operation.ts:344-363`).
- Grant changes: `refreshScopes` and revalidation end the session with `SCOPE_CHANGED`
  (`client-session.ts:1338-1444`); no cross-instance mechanism.
- Client: retraction hides rows and refuses unsent edits (`sync-engine.ts:3601-3637`,
  `outbound-queue.ts:390-404`); narrowing scans every collection (`store.ts:1595-1631`); local
  uplink refusal is terminal (`sync-engine.ts:4994-5030`).
- Gaps found: built-in `@korajs/auth` grants cannot be directional; RBAC's `__readonly` is not
  understood by the sync server; org routes do not refresh grants.

## 12. Changes in revision 2 (independent red-team review, 2026-10-08)

| Finding | Change |
|---|---|
| P0: a removed user keeps access while stalling their stream | Authorization at decision time; only the download stream re-scopes at S (5.1, 5.2) |
| P0: a document created offline loses its edits and comments | Offline-created groups granted locally, narrowing skips pending records, batch authorized op by op against the live index (5.5) |
| P0: insert with a colliding id gains 'manage' | Namespaced groups, refuse inserts onto existing group ids, owner field stamped, derived membership only on a fresh insert (4.1, 4.2) |
| P0: view key change re-downloads everything | Stable view identity and reconnect deltas (5.4) |
| P1: "index as of S" not computable | Membership index keeps join and leave sequences; re-scope uses the current index; convergence, not byte equality (4.1, 5.2) |
| P1: history before entry disclosed on full resync | History gated by `joined_seq` on every path (5.3) |
| P1: expiry had no sequence | Sweeper writes expiry operations; grace period (5.6) |
| P1: access kept through another `or()` branch | Rule fields immutable for clients (7.2) |
| P1: per-type grants and same-transaction writes understated | Called out as real changes with effort (6.3, 9) |
| P1: matcher not single; `$or` as a key | Structural `$or`, deny representation, every consumer listed (4.3, 6.2) |
| P1: one grant per chunk; atomic vs streamed | Chunk split at membership operations; re-scope units (5.2) |
| P1: `CLIENT_TOO_OLD` | Required for any `access` schema (6.1) |
| P1: `extraGrants` and `custom` underspecified | Directional `extraGrants`; `custom` pure, full re-evaluation (6.1, 7.4) |
| P2: `anyone()` writes, comment spoofing, grading, role lists, grant payload | `anyone()` read-only by default, `stamp`, field rules, ordered roles, grant diffs (3, 4.3) |
