# Design: `@korajs/spaces`, sharing on top of access rules

Status: revision 3 (north-star pass, decisions taken), for review. Date: 2026-10-13.
Depends on: access rules (`docs/guide/access-rules.md`, behind `experimentalAccessRules` until
beta.15), plus the framework changes in section 7. Changes from revision 1: section 12.

## 1. Problem

Access rules decide who may read and write a group once memberships exist. Every app that shares
still has to build the product around them:

- koraforms wrote a `form_collaborators` collection, four routes (invite, accept, change role,
  remove/leave), token generation, email checks, rate limits, audit events, a startup backfill
  and the glue to `server.access`: about 400 lines.
- koradocs needs the same for documents.

The hard parts sit on the trust boundary: invitation tokens, who may grant which role, binding an
invitation to a verified identity, races between role changes, removals and accepts, and the
owner. A mistake is an account takeover or a data leak, so it should be written and red-teamed
once.

## 2. Goals and non-goals

Goals:
- An app adds email-invitation sharing to a group collection in under 50 lines: a schema
  fragment, a route list, a client and React hooks.
- Invite, revoke an invitation, accept, decline, change a role, remove, leave, transfer. Every
  action is one atomic, conditional server write under the access engine.
- The member list and pending invitations are synced data: offline-readable, reactive.
- Optional. Apps with another model (LMS enrollment from payments, POS staff accounts) use
  `server.access` and `backfill` directly.

Non-goals for v1:
- Sending email (the app's `deliverInvitation`), accounts and sign-in (the app's `identify`; an
  `@korajs/auth` adapter ships).
- Inviting while offline (memberships are server writes).
- Link invitations ("anyone with the link"), Vue and Svelte hooks, a "removed edits" view
  (needs the rejected-operation store to keep payloads; section 7.4). Planned after v1.
- Organizations and nested groups.

## 3. Developer experience

Schema:

```typescript
import { defineSchema, t, member, owner } from 'korajs'
import { spacesCollections } from '@korajs/spaces'

const sharing = spacesCollections({
  roles: ['viewer', 'editor', 'admin', 'owner'],   // lowest to highest
  ownerRole: 'owner',                               // held only through the group's owner field
  manageRole: 'admin',                              // may invite, change roles, remove
  groups: { forms: { owner: 'ownerId' } },
})

export default defineSchema({
  version: 21,
  access: sharing.access,
  collections: {
    ...sharing.collections,
    forms: {
      fields: { title: t.string(), ownerId: t.string().stamp('userId') },
      access: { read: member('id'), create: owner('ownerId'), update: member('id', 'editor'), delete: member('id', 'owner') },
    },
  },
})
```

Server:

```typescript
import { spacesRoutes, koraAuthIdentity } from '@korajs/spaces/server'
import { sharing } from './schema'                          // the same spacesCollections() result

httpRoutes: [
  spacesRoutes({
    sharing,                                                // roles, ownerRole, manageRole, groups
    basePath: '/api/spaces',
    identify: koraAuthIdentity(userStore, verifyAccessToken), // { userId, email, emailVerified, displayName } | null
    acceptUrl: (token) => `${PUBLIC_URL}/invite#${token}`,    // fragment: never sent to servers or in Referer
    deliverInvitation: ({ email, url, group, invitedBy, role }) => mailer.send(/* ... */), // the app names the group and inviter
    describeInvitation: ({ group, invitedBy }) => ({ title: '...', inviterName: '...' }), // optional, for the accept page
  }),
]
```

Client:

```typescript
import { createSpaces } from '@korajs/spaces/client'
import { useMembers, useInvitations, useMyRole } from '@korajs/spaces/react'

const spaces = createSpaces(app, { basePath: '/api/spaces', headers: async () => ({ authorization: `Bearer ${await getToken()}` }) })

const members = useMembers(app, ['forms', formId])      // owner first, then members; offline
const invitations = useInvitations(app, ['forms', formId])
await spaces.invite(['forms', formId], { email, role: 'editor' })
await spaces.accept(tokenFromFragment)                   // resolves once this device has the membership
```

## 4. Model

### 4.1 Roles

- `roles` ordered lowest to highest; `ownerRole` and `manageRole` are explicit and distinct, with
  `manageRole` below `ownerRole` (validated by `spacesCollections`). koradocs' `view, comment,
  edit, manage` has no owner role, so it adds one (`owner` above `manage`).
- The owner is the group record's owner field and nothing else (the engine's `owner` interval).
  The kit refuses to write a membership row with `ownerRole`, so there is never a second owner.
- `manageRole` and above may invite, revoke invitations, change roles and remove. An actor acts
  only on a target whose current role is strictly below their own, and grants only roles strictly
  below their own; the owner may act on anyone. The same target check applies to role changes and
  removals, so a manager can neither demote nor remove a fellow manager.
- The owner role moves only by transfer; by default the previous owner keeps `manageRole` (a
  row written in the same set), so nobody loses data or unsent edits by giving a group away.
  `transfer(group, toUserId, { previousOwner: role | 'leave' })` chooses another role or none.
- Anyone but the owner may leave. The owner transfers first (`OWNER_CANNOT_LEAVE`).
- If an owner's account is gone, recovery is an operator action (`transferSpace` from a
  script); documented, not a route.

### 4.2 Collections

| Collection | Fields | Read |
|---|---|---|
| `space_members` (memberships) | `userId`, `group`, `role`, `invitedBy` | `memberOfKey('group')` |
| `space_invitations` (pending only) | `group`, `email`, `role`, `invitedBy`, `expiresAt`, `createdAt`, `tokenVersion` | `memberOfKey('group', manageRole)` |
| `space_invitation_secrets` | `invitationId`, `tokenHash`, `tokenVersion`, `authoritySource` (`membership` or `owner`), `authorityRecordId`, `authorityVersion`, `ownerVersion` | `serverOnly()`, never synced |

All are written only by the kit's routes. Ids are deterministic: `membershipRecordId(userId,
group)`; invitations `inv_` + hash(group, normalized email).

People data (names, avatars, emails of members) is not the kit's: every app already has its own
user profiles, with its own privacy rules, and copying them into kit collections would mean a
second source of truth to secure and reconcile. The hooks return user ids; the app renders them
with its own profiles (`useMembers(app, group, { profile: (userId) => ... })` is a convenience
for joining them in the hook). Managers see invitees' emails on pending invitations only.

The invitations collection holds pending invitations only: accept, decline and revoke delete the
invitation and its secret in the same transaction, so no invitee email outlives its invitation
and there is no status to keep consistent. Apps that want a history use `onEvent`. An expired
invitation is still a row until revoked or re-sent; routes and hooks treat `expiresAt <= now` as
expired (no sweeper).

### 4.3 Invitations

- Token: 32 random bytes, base64url. Only its SHA-256 is stored, with a `tokenVersion` that
  increments on every re-send, so a rotated token is dead even if a lookup races the rotation.
- Accept requires a signed-in caller whose verified email equals the invitation email
  (`EMAIL_NOT_VERIFIED`, `EMAIL_MISMATCH`). The kit never joins anyone automatically.
- An invitation to someone who is already a member (or the owner) is refused (`ALREADY_MEMBER`):
  changing a role is its own action, so an invitation can never demote anyone.
- An invitation records the inviter's authority at creation, read under the creation lock: the
  source (`membership` or `owner`), the record (the inviter's membership row, or the group
  record) and the version of the field that grants it (the membership's `role` field, or the
  group's owner field). Field versions are HLC timestamps the fold already keeps: every role
  change, removal and re-creation of the membership, and every transfer (including A to B and
  back to A, and operator transfers through `transferSpace`), writes that field with a
  new, never-repeating version. Accept requires the recorded version unchanged under the lock
  (7.2, read and copied under the lock at creation). Every invitation also stores the version
  of the group's owner field, whoever created it, and accept requires that unchanged too: a
  transfer, by the kit or an operator, resets every pending invitation of the group. Any demotion, removal or transfer after creation therefore kills the invitation, even
  after a later re-promotion or rejoin, with no epoch field to maintain and no query for "the
  inviter's invitations" that must be complete. A promotion also gives the role field a new
  version: the role route re-stamps the promoted member's pending invitations with it in the same
  transaction (a pending invitation it misses fails safe: it stops working and can be re-sent). Pending invitations of a demoted or removed
  member are also deleted, best effort.
- Operators transfer with the kit's server function, `transferSpace(server, { group, toUserId,
  previousOwner? })`, the same transaction the route runs (the incoming owner's member row is
  deleted, the previous owner's row written), not with raw `server.access.transfer`, which knows
  nothing of the kit's rows. No lazy reconciliation: every transfer leaves the rows consistent.
- No member cap in v1: a cap needs a group-level admission record serializing every accept for
  the group (a later addition; `beforeInvite` covers plan limits on invitations meanwhile).
- Limits: pending invitations per group (default 50, best effort under concurrent invites), invitations per recipient address per day
  across all groups (default 5), per-user request rate. These defaults protect the app's email
  sender reputation, which every app needs, so they are on by default and each is configurable
  (or off). Limits go through a `limiter` interface (`hit(key, limit, windowMs): Promise<boolean>`);
  the default is in memory per instance, and a multi-instance deployment passes its own shared
  limiter (Redis, its database); the kit does not ship one.
- `deliverInvitation` runs after the invitation commits; a failure is returned to the inviter
  (`DELIVERY_FAILED`). Delivery is not tracked or queued: every pending invitation offers a
  resend, which rotates the token, so a lost or late email is never a security problem and a
  delivery queue stays the app's (it already owns its mailer).

## 5. Routes

JSON over POST only (tokens never appear in URLs or logs). Responses set
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

| Route | Who | One atomic conditional write |
|---|---|---|
| `invitations/create` `{ group, email, role }` | may grant `role` | invitation + secret (upsert, `tokenVersion + 1`) |
| `invitations/revoke` `{ invitationId }` | manager of its group | invitation and secret deleted |
| `invitations/describe` `{ token }` | signed in | `{ role, expiresAt, emailHint }`, plus `describeInvitation`'s result for the matching invitee |
| `invitations/accept` `{ token }` | the invitee | if unexpired, token version matches, inviter still authorized, not a member: membership written, invitation and secret deleted |
| `invitations/decline` `{ token }` | the invitee | invitation and secret deleted |
| `members/role` `{ group, userId, role }` | may act on target and grant `role` | if target's role is still the one the actor saw: membership update (+ revoke target's pending invitations on demotion) |
| `members/remove` `{ group, userId }` | may act on target | if target's role unchanged: membership delete + revoke target's invitations |
| `leave` `{ group }` | a member, not the owner | membership delete |
| `transfer` `{ group, toUserId, previousOwner? }` (a role below the owner role, or `'leave'`; default `manageRole`) | the owner | if group owner is still the actor and target is a member: owner field update + previous owner's row (see 4.1) + new owner's row removed |

Every condition is evaluated inside `kora.transaction` under the store's locks (7.1, 7.2), never against a
read made earlier in the route. Errors: `{ error: { code, message } }`. Unknown, foreign, used and
revoked tokens all answer `INVITATION_NOT_FOUND`. Names (group title, inviter) come only from
the app's optional `describeInvitation`, shown only to a caller whose email matches.

Hooks: `onEvent({ type, group, actorId, targetUserId?, role?, invitationId?, email? })` for audit
logs (invitation events carry the invitation id and the invitee's email);
`beforeInvite(ctx)` for product limits (plans, allowed domains).

## 6. Client

- `createSpaces(app, { basePath, headers, fetch? })`. Each call sends `headers()` (the app owns
  how a bearer token reaches HTTP; an `@korajs/auth` helper provides it). A network failure maps
  to `SpacesOfflineError`; nothing is queued.
- `accept` resolves when the caller's own `space_members` row is present locally (always
  readable to them), or after `timeoutMs` (default 10 s) with `{ pending: true }`. It never waits
  for the group record, which the invited role may not be allowed to read.
- Hooks: `useMembers` (owner from the group record, then members, as user ids; a kit-managed
  group's read rule must admit every member, as `member('id')` does: being in a space and not
  seeing it is not a model the kit supports; when a member cannot read the group record,
  `useMembers` lists the members without the owner),
  `useInvitations` (pending and expired, managers only), `useMyRole` (UI only; the server decides).
- A manager who invites before their offline-created group reached the server gets
  `GROUP_NOT_SYNCED` with a retry hint, not `NOT_A_MEMBER`.

## 7. Framework changes the kit needs (land first, each with tests)

1. **Atomic conditional sets on every store.** Today only the Postgres store implements
   `ServerStore.applyConditional`; with SQLite and memory, `kora.applyConditional` commits the
   set one operation at a time, so a failure part way leaves part of it applied. Implement it in
   the SQLite store (one transaction) and the memory store, and test that membership intervals
   derived from a memberships write in the set open in the same transaction.
2. **A locked read-decide-write transaction.** Accept must check the invitation, the inviter's
   authority and the invitee's absence; invitation creation must read the inviter's authority
   version and copy it into the secret row. Declarative predicates cannot do both, so the route
   context gains:

   ```typescript
   await kora.transaction({
     lock: [['space_invitations', id], ['space_members', inviterRowId], ['forms', formId]],
     run: (locked) => {
       // locked[i]: { record, deleted, fieldVersions } | null, read under the locks
       return { reject: { code: 'INVITER_NO_LONGER_AUTHORIZED' } } // or { mutations: [...] }
     },
   })
   ```

   `run` is synchronous and pure over the locked state; the store takes the locks (Postgres:
   advisory locks in a fixed order; SQLite and memory: one transaction), reads every record with
   its deleted flag and fold field versions, runs `run`, and commits its mutations or nothing.
   Absence is `locked[i] === null || locked[i].deleted`; authority is a field version.
   `applyConditional` becomes a thin wrapper over it. Every `server.access` write (`grant`,
   `revoke`, `transfer`, `backfill`, the expiry sweep) also runs through it, taking the same
   locks (the group record, the membership row), so no framework write can slip between a kit
   route's read and its commit; locks are cooperative only if every writer takes them, and the
   framework's own writers do.
3. **Authorization coupled to the write.** `access.roleOf(userId, group)` on `AccessApi` reads
   the effective role (owner field or live membership, expiry judged at server time) from the
   index for display and early refusals. The decision itself runs inside `kora.transaction`
   (7.2), over the actor's membership row (the kit writes only derived ids) and the group
   record's owner field, both locked. A manager revoked or demoted after
   the route's read therefore cannot complete the write. The index is derived from exactly those
   rows in the same transaction, so the check and the engine agree.
4. **Rejected operations keep their payload** (later, for the removed-edits view): out of v1.

`backfill` (#31) is the path for apps that keep their own source of truth.

## 8. Security checklist

- Tokens: hash only, versioned, single use, POST-only, fragment URLs, no-referrer, server clock.
- Binding: verified email; no auto-join; no link invitations in v1.
- Escalation: strictly-below rule; owner only by transfer; all checks under the commit lock;
  inviter re-checked at accept; demotion and removal revoke pending invitations.
- Races: role change vs remove, accept vs revoke, transfer vs leave all decided by the store's
  lock (7.1, 7.2), and tested with concurrent requests on Postgres and SQLite.
- Enumeration: uniform not-found; `emailHint` only (`j***@example.com`); group title only for the
  matching invitee.
- Abuse: per-group pending cap, per-recipient daily cap, per-user rate, shared limiter for
  several instances.
- Exposure: emails readable by managers only; secrets never synced.

## 9. Fit

| App | Uses the kit? | Notes |
|---|---|---|
| koraforms | yes | migration: switch memberships collection to `space_members` (the index rebuilds and every device re-scopes once), move accepted collaborators with `backfill`, re-send pending invitations (old tokens are stored in clear and must die), drop `form_collaborators` |
| koradocs | yes | adds an `owner` role above `manage` (owner and manager roles must differ) |
| korapos | no | staff are created by the business and often have no verified email: `server.access` from the app's staff routes |
| LMS | no | enrollment follows payment: `backfill` / `grant` from the payment webhook; may use `useMembers` |

## 10. Decisions (2026-10-13)

Test applied to each: does it make the default path simpler or safer for every app that shares,
without deciding something only one app should decide?

1. **Invitation caps: on by default, configurable.** Email abuse hurts every app's sender
   reputation and no developer thinks to guard against it on day one; secure defaults are part of
   "it just works". Values (5 per recipient per day, 50 pending per group) are defaults, not law.
2. **Previous owner after a transfer: keeps `manageRole` by default.** Giving something away
   should never cost the giver their access or their unsent offline edits by surprise;
   `previousOwner` overrides it.
3. **Package layout: one `@korajs/spaces` with `/server`, `/client`, `/react` entry points**, as
   Next.js does (`next/navigation`, `next/server`). One install, one version, tree-shaken.
4. **Owner and manager roles must differ.** One clear model (an owner, managers below) is what
   Google Drive, Notion and GitHub use; koradocs adds an `owner` role.
5. **Cut from the kit by the same test:** profile data (`space_people`, `space_contacts`, display
   names: apps own their user profiles), delivery tracking (apps own their mailer), a bundled
   Postgres limiter (apps own their infrastructure), link invitations and removed edits (later,
   when an app needs them).
6. **What stays in the framework, not the kit:** only primitives every kind of app can use (7.1
   atomic multi-record writes, 7.2 `kora.transaction`, 7.3 `access.roleOf`): an inventory,
   booking or ledger app needs a locked read-decide-write as much as sharing does.

## 11. Effort

| Part | Days |
|---|---|
| 7.1 atomic conditional sets (SQLite, memory) | 2 |
| 7.2 multi-record conditions, 7.3 `roleOf` | 2 |
| Schema fragment, ids, routes, limits, events | 2.5 |
| Client, React hooks, `@korajs/auth` adapter | 1.5 |
| Adversarial and concurrency tests, koraforms migration | 2.5 |
| Docs and template recipe | 1 |

About 11 days; the framework changes (7.1 to 7.3) are useful on their own and land first.

## 12. Changes in revision 2 (independent review, 2026-10-12)

| Finding | Change |
|---|---|
| P0: a role change racing a removal could bring the member back; checks were separate reads | Every action is one conditional set decided under the store lock; 7.1, 7.2 |
| P0: link invitations plus member-visible emails exposed every email | No link invitations in v1; emails in `space_contacts`, managers only |
| P1: `request.access` has no read API | `access.roleOf` (7.3) |
| P1: the owner has no membership row; an `owner` row would create a second owner | Owner is the owner field only; owner rows refused; `space_people` for the owner's name |
| P1: transfer did not check the target or the actor and dropped the old owner's access | Conditional transfer; old owner keeps `manageRole` |
| P1: accept wrote a raw insert that could demote an existing member | `ALREADY_MEMBER`; role changes are their own action |
| P1: `applyConditional` is not atomic on SQLite and memory; rotated tokens could race | 7.1; `tokenVersion` checked under the lock |
| P1: invitations outlived a removed or demoted inviter | Inviter re-checked at accept; their invitations revoked on removal or demotion |
| P1: removed edits not buildable (rejected operations carry no payload) | Out of v1; 7.4 |
| P1: `accept` waited for a record the role may not read | Waits for the caller's own membership row |
| P1: fit table (koradocs roles, korapos identities, koraforms migration) | Explicit `ownerRole`; korapos and LMS use the engine; migration spelled out |
| P1: invitations could email-bomb strangers | Per-recipient and per-group caps, shared limiter interface |
| Codex: a manager could demote a fellow manager, then remove them | Target-rank check on role changes as on removals (4.1) |
| Codex: no atomic, index-backed authorization primitive | Actor checks run inside the locked transaction (7.2, 7.3) |
| Codex: member cap race across invitations | No member cap in v1; needs a group admission record |
| Codex: an invitation created while its inviter was being demoted survived the cleanup | Invitations record the inviter's authority version; accept requires it unchanged (4.3) |
| Codex: the inviter epoch was not stored; epochs could restart on rejoin; operator transfers A to B to A were invisible | Authority is the field version of the membership's `role` or the group's owner field, stored with the secret; never repeats (4.3) |
| Codex: no way to require a record's absence | Absence is checked under the lock in `kora.transaction` (7.2) |
| Codex: `ownerRole` equal to `manageRole` broke transfer | The two must differ (4.1); koradocs adds an owner role |
| Codex: routes had no role policy; the authority version could not be captured | `spacesRoutes({ sharing })`; `kora.transaction` reads locked records with field versions and decides the writes (7.2) |
| Codex: a manager's invitation survived operator transfers A to manager to A | Every invitation also pins the owner-field version; a transfer resets all pending invitations (4.3) |
| Codex: delivery not durable, resends could arrive out of order | `deliveredVersion` shows unsent invitations; rotated tokens make stale emails harmless (4.3) |
| Codex: a slow delivery callback could lower `deliveredVersion`; no source for a transferred owner's name | Monotonic update; name from the member row, `resolveProfile`, or empty (4.3) |
| Codex (rev 3): promotions invalidated invitations; schema-less startup check; audit events lacked the invitation | Promotions re-stamp the member's invitations; no startup check (owner omitted when unreadable); events carry `invitationId` and `email` |
| Codex (rev 3): consecutive operator transfers left stale owner rows; owner unreadable to some members | Operators use `transferSpace` (no lazy reconciliation); group read rules must admit every member, checked at startup |
| Codex (rev 3): operator transfers did not take the advisory lock | Every `server.access` write runs through `kora.transaction` with the same locks (7.2) |
| Codex (rev 3): emails stayed on terminal invitations; no source for inviter names; `previousOwner` not in the route | Pending-only invitations (terminal = deleted); names from `describeInvitation`; route carries `previousOwner` |
| Codex: former owner's contact row survived operator transfers | Reconciliation deletes it when no membership remains (4.3) |
| Codex: operator transfer to a member left their row | First-touch reconciliation deletes the owner's member row (4.3) |
| Codex: `space_people` had no creation path | Written lazily by the first kit route and on transfers; owner shown from the group record until then (4.3) |
| Codex: link tokens in GET paths; owner missing from hooks | No link invitations; POST and fragment URLs; owner from the group record (6) |
| P2: tokens in URLs, offline detection, auth header, expired status, unsynced group, owner recovery | POST and fragment URLs, network-failure mapping, `headers()`, expiry judged on read, `GROUP_NOT_SYNCED`, operator recovery documented |

## 13. Changes in revision 3 (north-star pass, 2026-10-13)

Profile and contact collections, the owner's profile row and its reconciliation, delivery
tracking and the bundled limiter are removed (section 10.5). Transfer gains `previousOwner`.
Open questions are decided (section 10).
