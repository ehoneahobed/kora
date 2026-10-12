# Design: `@korajs/spaces`, sharing on top of access rules

Status: revision 2, for review (Codex plus independent review before code). Date: 2026-10-12.
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

httpRoutes: [
  spacesRoutes({
    basePath: '/api/spaces',
    identify: koraAuthIdentity(userStore, verifyAccessToken), // { userId, email, emailVerified, displayName } | null
    acceptUrl: (token) => `${PUBLIC_URL}/invite#${token}`,    // fragment: never sent to servers or in Referer
    deliverInvitation: ({ email, url, inviterName, groupTitle, role }) => mailer.send(/* ... */),
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

- `roles` ordered lowest to highest; `ownerRole` and `manageRole` are explicit (no positional
  inference: koradocs' `view, comment, edit, manage` has no owner role and must declare one).
- The owner is the group record's owner field and nothing else (the engine's `owner` interval).
  The kit refuses to write a membership row with `ownerRole`, so there is never a second owner.
- `manageRole` and above may invite, revoke invitations, change roles and remove; each only for
  roles strictly below their own, except the owner, who may act on anyone.
- The owner role moves only by transfer; the previous owner keeps `manageRole` (a row written in
  the same set), so their unsent edits are not refused.
- Anyone but the owner may leave. The owner transfers first (`OWNER_CANNOT_LEAVE`).
- If an owner's account is gone, recovery is an operator action (`server.access.transfer` from a
  script); documented, not a route.

### 4.2 Collections

| Collection | Fields | Read |
|---|---|---|
| `space_members` (memberships) | `userId`, `group`, `role`, `displayName`, `invitedBy` | `memberOfKey('group')` |
| `space_people` | `group`, `userId`, `displayName` (one row for the owner, written by the kit) | `memberOfKey('group')` |
| `space_contacts` | `group`, `userId`, `email` | `memberOfKey('group', manageRole)` |
| `space_invitations` | `group`, `email`, `role`, `invitedBy`, `status`, `expiresAt`, `createdAt`, `tokenVersion` | `memberOfKey('group', manageRole)` |
| `space_invitation_secrets` | `invitationId`, `tokenHash`, `tokenVersion` | `serverOnly()`, never synced |

All are written only by the kit's routes. Fellow members see names, never emails; managers see
the emails they need to manage invitations. Ids are deterministic: `membershipRecordId(userId,
group)`; invitations `inv_` + hash(group, normalized email); contacts and people by (group, user).

`status` is `pending`, `accepted`, `declined` or `revoked`; an expired invitation stays `pending`
in storage and the hooks and routes treat `expiresAt <= now` as expired (no sweeper needed).

### 4.3 Invitations

- Token: 32 random bytes, base64url. Only its SHA-256 is stored, with a `tokenVersion` that
  increments on every re-send, so a rotated token is dead even if a lookup races the rotation.
- Accept requires a signed-in caller whose verified email equals the invitation email
  (`EMAIL_NOT_VERIFIED`, `EMAIL_MISMATCH`). The kit never joins anyone automatically.
- An invitation to someone who is already a member (or the owner) is refused (`ALREADY_MEMBER`):
  changing a role is its own action, so an invitation can never demote anyone.
- At accept, the inviter must still hold a role that may grant the invited role; otherwise the
  invitation is refused (`INVITER_NO_LONGER_AUTHORIZED`). Removing or demoting a member also
  revokes their pending invitations in the same set.
- Limits: pending invitations per group (default 50), invitations per recipient address per day
  across all groups (default 5), per-user request rate. Limits go through a `limiter` interface
  (`hit(key, limit, windowMs): Promise<boolean>`); the default is in-memory per instance, and a
  multi-instance deployment passes a shared one (a Postgres-backed limiter ships).
- `deliverInvitation` runs after the invitation commits. A delivery failure is returned to the
  inviter (`DELIVERY_FAILED`, invitation kept, resend allowed), never a silent pending row.

## 5. Routes

JSON over POST only (tokens never appear in URLs or logs). Responses set
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

| Route | Who | One atomic conditional write |
|---|---|---|
| `invitations/create` `{ group, email, role }` | may grant `role` | invitation + secret (upsert, `tokenVersion + 1`) |
| `invitations/revoke` `{ invitationId }` | manager of its group | status `revoked` if `pending` |
| `invitations/describe` `{ token }` | signed in | `{ groupTitle?, role, inviterName, expiresAt, emailHint }` |
| `invitations/accept` `{ token }` | the invitee | if pending, unexpired, token version matches, inviter still authorized, not a member: membership + contact + status `accepted` |
| `invitations/decline` `{ token }` | the invitee | status `declined` |
| `members/role` `{ group, userId, role }` | may act on target and grant `role` | if target's role is still the one the actor saw: membership update (+ revoke target's pending invitations on demotion) |
| `members/remove` `{ group, userId }` | may act on target | if target's role unchanged: membership delete + contact delete + revoke target's invitations |
| `leave` `{ group }` | a member, not the owner | membership delete + contact delete |
| `transfer` `{ group, toUserId }` | the owner | if group owner is still the actor and target is a member: owner field update + old owner's `manageRole` row + new owner's row removed + `space_people` update |

Every condition is evaluated by the store under its lock at commit (section 7.1), never against a
read made earlier in the route. Errors: `{ error: { code, message } }`. Unknown, foreign, used and
revoked tokens all answer `INVITATION_NOT_FOUND`. `groupTitle` comes from an app callback
(`describeGroup`) and is shown only to a caller whose email matches the invitation.

Hooks: `onEvent({ type, group, actorId, targetUserId?, role? })` for audit logs;
`beforeInvite(ctx)` for product limits (plans, allowed domains).

## 6. Client

- `createSpaces(app, { basePath, headers, fetch? })`. Each call sends `headers()` (the app owns
  how a bearer token reaches HTTP; an `@korajs/auth` helper provides it). A network failure maps
  to `SpacesOfflineError`; nothing is queued.
- `accept` resolves when the caller's own `space_members` row is present locally (always
  readable to them), or after `timeoutMs` (default 10 s) with `{ pending: true }`. It never waits
  for the group record, which the invited role may not be allowed to read.
- Hooks: `useMembers` (owner from the group record and `space_people`, then members),
  `useInvitations` (pending and expired, managers only), `useMyRole` (UI only; the server decides).
- A manager who invites before their offline-created group reached the server gets
  `GROUP_NOT_SYNCED` with a retry hint, not `NOT_A_MEMBER`.

## 7. Framework changes the kit needs (land first, each with tests)

1. **Atomic conditional sets on every store.** Today only the Postgres store implements
   `ServerStore.applyConditional`; with SQLite and memory, `kora.applyConditional` commits the
   set one operation at a time, so a failure part way leaves part of it applied. Implement it in
   the SQLite store (one transaction) and the memory store, and test that membership intervals
   derived from a memberships write in the set open in the same transaction.
2. **Conditions on more than the target record.** Accept must check the invitation (target) and
   the inviter's role and the invitee's membership. Add `requires: [{ collection, id, if }]` to
   `applyConditional`, evaluated under the same lock (Postgres: advisory locks taken in a fixed
   order).
3. **`access.roleOf(userId, group)`** on `AccessApi`: the effective role (owner field or live
   membership, expiry judged at server time) from the index, so routes do not reimplement it.
   Plus a store-level variant usable inside `admit`.
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
| koradocs | yes | declares `ownerRole: 'manage'` explicitly, or adds an owner role |
| korapos | no | staff are created by the business and often have no verified email: `server.access` from the app's staff routes |
| LMS | no | enrollment follows payment: `backfill` / `grant` from the payment webhook; may use `useMembers` |

## 10. Open questions

1. Default per-recipient cap (5 per day) and pending cap per group (50)?
2. Should the previous owner keep `manageRole` after a transfer, or the role the owner chooses?
3. Package layout: one `@korajs/spaces` with `/server`, `/client`, `/react` entry points and
   `@korajs/server` as a peer dependency (recommended).

## 11. Effort

| Part | Days |
|---|---|
| 7.1 atomic conditional sets (SQLite, memory) | 2 |
| 7.2 multi-record conditions, 7.3 `roleOf` | 2 |
| Schema fragment, ids, routes, limits, events | 3 |
| Client, React hooks, `@korajs/auth` adapter | 1.5 |
| Adversarial and concurrency tests, koraforms migration | 2.5 |
| Docs and template recipe | 1 |

About 12 days; the framework changes (7.1 to 7.3) are useful on their own and land first.

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
| P2: tokens in URLs, offline detection, auth header, expired status, unsynced group, owner recovery | POST and fragment URLs, network-failure mapping, `headers()`, expiry judged on read, `GROUP_NOT_SYNCED`, operator recovery documented |
