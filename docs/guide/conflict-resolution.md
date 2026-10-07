---
title: Conflict Resolution
description: "How Kora.js merges concurrent edits: one deterministic per-field CRDT fold on every replica, merge strategies, custom resolvers, server-authoritative fields, constraints and relations."
---

# Conflict Resolution

Devices write offline and concurrently. Kora merges their writes so that every replica (each
device, the sync server, a restored backup) ends up with the same record, without any code from
you. This page says exactly how.

## One fold, everywhere

Every write produces an immutable operation. A replica appends each operation it receives to its
log and **folds** it into the record's merge state: per field, exactly what that field's rule
needs (a last-write-wins register, element add and remove times, per-key registers, counter
deltas, a resolver's write log, Yjs updates). Folding is commutative, associative and idempotent,
so a record depends only on the **set** of operations a replica holds: not their arrival order,
not duplicates, not batching. Two replicas that hold the same operations show the same record.

The row you query is the materialization of that state, written in the same transaction as the
operation. The server folds with the same code (`@korajs/core`), so the server and devices agree
by construction.

"Later" always means the operation stamp: the Hybrid Logical Clock timestamp, then the operation
id. The HLC orders causally related writes correctly without synchronized clocks, and the id
breaks every remaining tie, so there is never an ambiguity.

### What counts as a write

- An **insert** writes every field it carries. An insert onto a record that already exists
  merges per field; it does not reset fields it does not carry.
- An **update** writes a field only when its value differs from the writer's own `previousData`
  for that field (or it carries an atomic op such as `op.increment`). Re-sending an unchanged
  field (a form that saves every field) is not a write and never overrides a concurrent change.
- An update to a record whose insert has not arrived yet waits for it; it does not create a row.
- **Delete vs write**: the later of the newest delete and the newest write decides. A record
  revived by a later write shows every field's merged value.
- An operation the server refused for good is left out: its author re-folds the record without
  it and converges to the server.

## Default rules per field type

| Field type | Rule | Trace strategy |
|------------|------|----------------|
| `string`, `number`, `boolean`, `enum`, `timestamp`, `blob`, `secret` | last write wins | `lww` |
| `array` | element multiset (below) | `lww-element-set` |
| `object`, `json` | per top-level key, last write wins | `object-key-lww` |
| `richtext` | Yjs CRDT, character-level | `crdt-text` |

### Scalars

```
Device A writes title = "Buy milk"   at HLC(1000, 0, A)
Device B writes title = "Buy bread"  at HLC(1001, 0, B)
Every replica: title = "Buy bread"
```

Atomic ops compose: `op.increment(n)` on two offline devices merges to the sum of both deltas.
Since the newest plain write, a chain of the same atomic op composes (increments add up, `op.max`
keeps the maximum); any other write takes its resolved value.

### Arrays

An array write is read as the elements it **adds** and **removes** compared with the array the
writer started from (its `previousData`). Each element **occurrence** keeps the stamp of its
newest add and its newest removal, and is present when the add is later:

```
Base:     tags = ["work", "old"]
Device A: tags = ["work", "urgent"]           (removes "old", adds "urgent")
Device B: tags = ["work", "old", "important"] (adds "important")
Merged:   tags = ["work", "urgent", "important"]
```

- **Duplicates are kept.** `["a", "a"]` is two occurrences of `"a"`. Removing one copy removes
  one occurrence. Two devices that each add the same value to the same starting array add the
  *same* occurrence, so the result holds it once.
- **A removal beats an unchanged copy.** Device B above kept `"old"` without touching it, so A's
  removal stands.
- **Order** is the order elements were first added (stamp of the write, then position in it), not
  the last writer's order.
- Elements compare by value; objects inside arrays compare by canonical JSON (key order ignored).
- Writing `null` (or any non-array) replaces the whole value and clears earlier elements.
- `op.append(x)` and `op.remove(x)` are the same multiset difference against the writer's array:
  appending a value already present adds another copy; removing removes every copy the writer saw.

### Objects and JSON

`t.object()` and `t.json()` merge per top-level key: concurrent edits of different keys both
survive, the later write of the same key wins, and a removed key stays removed unless written
again later. A value nested under a key is replaced as a whole (last write wins), so keep
independently edited data under separate top-level keys. A non-object write (`null`, a scalar, a
JSON array) replaces the whole value.

**Changing one key.** An update writes the whole value of the field; the keys that count as
written are the ones that differ from the value stored on the device at that moment (the update's
`previousData`). Two consequences:

- Do not build the new object from a value your UI rendered earlier. If another change to a
  different key landed since (a peer's edit, another component), spreading the stale render
  writes the old value of that key back and reverts it.
- Do not write only the changed key: `{ theme: 'dark' }` as the whole value removes every key it
  leaves out.

Merge into the current stored value, read in the same transaction, so nothing can land in
between:

<!-- docs-check: skip illustrative; the collection and id come from your app -->
```typescript
await app.transaction(async (tx) => {
  const current = await tx.profiles.findById(id)
  await tx.profiles.update(id, { settings: { ...current?.settings, theme: 'dark' } })
})
```

Only `theme` differs from the stored value, so only `theme` is written: a concurrent change of
another key on another device still merges.

### Rich text

`t.richtext()` fields hold Yjs updates, merged by Yjs at character level: two users typing in the
same document converge. Writing a plain string resets the text (it hides updates written before
it). Each replica keeps only the updates no other update contains, so the state stays bounded,
and the stored column is the canonical encoding of the merged document, byte-identical across
devices. Edit it with [`useRichText`](/guide/react-hooks#userichtext).

## Merge strategies

`.merge(strategy)` on a field replaces its default rule:

```ts
import { t } from 'korajs'

const fields = {
  quantity: t.number().merge('counter'),
  highScore: t.number().merge('max'),
  lowestBid: t.number().merge('min'),
  auditLog: t.array(t.string()).merge('append-only'),
  approval: t.enum(['pending', 'approved', 'rejected']).merge('server-authoritative'),
}
```

| Strategy | Rule | Use for |
|----------|------|---------|
| `'counter'` | the base (the insert, or the newest non-numeric write) plus every delta written after it (`value - previousData`, or the increment) | stock, scores, votes |
| `'max'` / `'min'` | the extremum of every numeric write | high scores, lowest bids |
| `'append-only'` | an array whose removals are ignored | logs, history |
| `'union'` | the array default (element multiset) | |
| `'lww'` | last write wins | |
| `'server-authoritative'` | writes by the sync server beat device writes (below) | approvals, moderation |

Every strategy folds over **all** writes, so three or more concurrent writers never lose an
update:

```
Base 100. Device A sells 3 (97), device B sells 5 (95), device C sells 1 (99).
counter: 100 - 3 - 5 - 1 = 91 on every replica
```

### Server-authoritative fields

For `merge('server-authoritative')`, writes are in two classes. A write by the sync server beats
every device write of the field, even a later one; within a class, last write wins. A write is
the server's when its node id is in the reserved `kora:server:` namespace (every server instance
authors as `kora:server:<deploymentId>:<instanceId>`), or is one of the explicit ids the server
lists in the handshake (`authoritativeNodeIds`: legacy server node ids from before beta.13, and
extras you configure on the server store). Devices keep every explicit id they learn and never
forget one unless the server revokes it (`revokedAuthoritativeNodeIds`, permanent); records
re-fold when the set changes. Devices can never author under a `kora:` node id: a configured one
is refused (`RESERVED_NODE_ID`) and a handshake presenting one is refused (`INVALID_NODE_ID`).

Write such a field from the server: a route mutation (`request.kora`) or a validator. See
[Production Server](/guide/production-server).

## Custom resolvers

When no strategy fits, give the field a resolver in the collection's `resolve` map:

```ts
import { defineSchema, t } from 'korajs'

export default defineSchema({
  version: 1,
  collections: {
    documents: {
      fields: {
        title: t.string(),
        status: t.enum(['draft', 'review', 'published']).default('draft'),
      },
      resolve: {
        // The furthest status any device reached wins.
        status: (local, remote) => {
          const rank: Record<string, number> = { draft: 0, review: 1, published: 2 }
          return (rank[String(local)] ?? 0) >= (rank[String(remote)] ?? 0) ? local : remote
        },
      },
    },
  },
})
```

Every replica folds the field's writes in stamp order. The first write sets the value; for every
later write the resolver is called once with:

| Argument | Value |
|----------|-------|
| `local` | the value merged so far (every earlier write, in stamp order) |
| `remote` | the value of the write being folded |
| `base` | that write's `previousData` for the field (`null` for an insert) |

The resolver does not need to be commutative (the order is fixed), but it must be pure and
deterministic. Its output is normalized like a written value (`-0` is `0`, a `Date` its ISO
string, `undefined` is `null`). If it throws, or returns a value with no JSON form (`NaN`, a
`Map`), the write's own value is used and the error is reported on the merge trace.

## Constraints

Rules that span records cannot be folded per record, so the **sync server is their authority**.
Declare them per collection, as a list:

```ts
import { defineSchema, t } from 'korajs'

export default defineSchema({
  version: 1,
  collections: {
    seats: {
      fields: { eventId: t.string(), seatNumber: t.string(), claimedBy: t.string().optional() },
      constraints: [
        { type: 'unique', fields: ['eventId', 'seatNumber'], onConflict: 'first-write-wins' },
      ],
    },
    members: {
      fields: { teamId: t.string(), userId: t.string(), role: t.string(), joinedAt: t.number() },
      constraints: [
        { type: 'unique', fields: ['teamId', 'userId'], onConflict: 'priority-field', priorityField: 'joinedAt' },
      ],
    },
  },
})
```

| Property | Meaning |
|----------|---------|
| `type` | `'unique'`: no two records share the values of `fields`. `'capacity'`: at most one record per group of `fields` (scoped by `where`); there is no numeric limit option. `'referential'`: the first field references a record of the collection named in `where.collection`. |
| `fields` | The fields the rule is about. |
| `where` | For unique and capacity: the constraint applies only among records whose fields equal these values (plain equality), both for the record being written and for the records it is compared against, so `{ type: 'unique', fields: ['slug'], where: { status: 'published' } }` lets a draft share a published slug. When a write (such as publishing a draft) creates a duplicate, the server undoes that write, here the status change. `defineSchema` refuses an operator object (`{ $ne: 'draft' }`), an array, or a field the collection does not have, since none of them could ever match. |
| `onConflict` | Which write wins a race: `'last-write-wins'` the newest, `'priority-field'` the highest `priorityField` (ties: first write wins), and every other value (`'first-write-wins'`, `'server-decides'`, `'custom'`) the oldest. A constraint's `resolve` function is not called. |

How they are enforced:

1. **At ingest** the server judges the record as the fold would materialize it after the
   operation. A violating operation is refused before it is stored (`CONSTRAINT_VIOLATION`,
   reported to its author by `sync:operation-rejected`), so no replica ever folds it.
2. **Races.** Two writes validated concurrently (two sessions, two server instances) can both
   commit. After every commit the server re-checks and writes a **correction**: the losing write
   is undone on the constrained fields (the fields go back to the values the record folds to
   without it), or the record is deleted when that write created it. Corrections are ordinary
   operations authored by the server's node with deterministic ids, so two detectors produce one
   correction, and every device folds it.
3. **Devices** check constraints optimistically after applying a remote operation and emit
   `constraint:violated` for DevTools. They do not rewrite the record themselves, so every replica
   keeps folding the same operations.

## Relations

`onDelete` rules are enforced on the deleting device and, authoritatively, on the server (see
[Schema Design](/guide/schema-design#relations)). Concurrent writes resolve like this:

| Race | Outcome |
|------|---------|
| A device deletes a parent while another writes a child under it, `cascade` | the server deletes the child |
| same, `set-null` | the server clears the child's foreign key |
| same, `restrict` | the server revives the parent: the delete loses, since it was allowed only because the child was not committed yet |
| a `restrict` parent is deleted while a child is live | the server refuses it (`RESTRICTED`), or revives it if both raced |
| any race, `no-action` | both writes stand (the child may point at a deleted parent) |

A revival is an update with empty data: a write newer than the delete that changes no field, so
the record comes back with every field's merged value.

## State machines

Enum `.transitions()` (and a collection `stateMachine`) are checked when a device writes. The
fold itself merges the field last-write-wins like any enum, so concurrent valid changes from two
devices can meet in an order the transition map does not list. Enforce cross-device order on the
server (`validateOperation`) or with a server-authoritative field. See
[State Machines](/guide/state-machines).

## When a record enters your sync scope

When a record becomes visible to a device (a share, a new grant), the server sends it as a scope
entry carrying the record's fold state. The device joins that state with its own, so counters,
rich text, resolvers and arrays keep any concurrent local edits instead of being overwritten.
Each restated field keeps exactly its own version.

## Inspecting merges

Every fold decision that was a conflict is a `MergeTrace` (`merge:conflict` events, with
`merge:started` and `merge:completed` around them): the operations, the field (`*` for a
delete-vs-write decision), the strategy from the tables above, the inputs, the base, the output,
the tier (1 for built-in rules, 3 for resolvers, 2 for constraint checks) and the duration.
Secret fields are redacted. Traces are shown in the [DevTools](/guide/devtools) Conflict
Inspector and in `kora studio`, and persisted to the local audit trail (`app.exportAudit()`).

## What changed from beta.12

Each change fixes a case where devices or the server could disagree forever:

1. Arrays are multisets merged per element occurrence (no pairwise add-wins set): duplicates are
   kept, order is first-add order, a removal beats an unchanged copy.
2. Objects merge per top-level key only; nested values are whole-value last-write-wins (beta.12
   recursed into nested objects pairwise).
3. An update that restates a field unchanged no longer wins last-write-wins for it (every field
   kind, not only arrays).
4. Custom resolvers see `local` = the merged value so far, once per write in stamp order, instead
   of a device's local row once per concurrent pair.
5. An insert onto an existing record merges per field (the server used to reset it).
6. `merge('server-authoritative')` lets server writes win; it was plain last-write-wins.
7. `merge('counter' | 'max' | 'min' | 'append-only')` fold over every write instead of a formula
   over two concurrent writes, so three or more writers no longer lose updates.
8. `op.append` of a value already present adds a copy; `op.remove` removes every copy.
9. An update whose insert never arrived does not create a row.
10. A scope entry joins the server's fold state for every field kind.
11. Cross-record constraints are decided by the server (refusal at ingest, then corrections); devices
    no longer resolve them locally, and a concurrent state-machine change is no longer judged by
    the merge.
12. Schema transforms run at fold time: operations are stored and synced exactly as written.

**Upgrading a device.** The first open with beta.13 **re-materializes** every record from its log
(`store:rematerialized`), which also repairs devices that diverged under earlier releases; visible
values can change on such devices. A log compacted before the upgrade uses the current rows as
starting points ("row snapshots"); a record that owns quarantined log rows (see
`store.verifyLogIntegrity()`) keeps its row exactly as it is. A row snapshot cannot tell whether a
late, older write (a counter delta, an array add) is already in its value, so the store asks the
server for one full resync and drops each snapshot once the record's history is back;
`store.getSnapshotRecords()` lists the records still on one.

**Changing how a field merges** (to `.merge('counter')`, to `append-only`, a new or edited
resolver) re-folds that collection on the next open: devices and the server record a fold-plan
fingerprint per collection. Compacted history of a re-planned field restarts from its value at its
newest write.

**Comparing with the old pipeline.** For this one beta,
`createApp({ experimental: { legacyMerge: true } })` runs the beta.12 pairwise pipeline instead.
Switching it on or off re-materializes the database on open. It is removed in the next release,
together with the deprecated `MergeEngine` and `addWinsSet` exports of `@korajs/merge`.
