# Design: `@korajs/spaces`, sharing on top of access rules

Code: `packages/spaces` (entry points `.`, `/server`, `/client`, `/react`). User guide:
`docs/guide/sharing.md`. Depends on access rules (`docs/guide/access-rules.md`) and on the server
route context's `kora.transaction` and `roleOf` (`docs/api/server.md`).

## Problem

Access rules decide who may read and write a group once memberships exist. Every app that shares
still has to build the product around them: a collaborators collection, invite / accept / change
role / remove routes, token generation, email checks, rate limits, audit events, and the glue to
`server.access`. In a production app this came to roughly 400 lines, and every other app that
shares needs the same.

The hard parts sit on the trust boundary: invitation tokens, who may grant which role, binding an
invitation to a verified identity, races between role changes, removals and accepts, and the
owner. A mistake there is an account takeover or a data leak, so it should be written and
red-teamed once.

## Scope

The kit provides email-invitation sharing for one or more group collections: invite, re-send,
revoke, describe, accept and decline invitations; change a role, remove, leave, transfer. Every
action is one atomic server transaction. The member list and pending invitations are synced data,
readable offline and reactive.

Not in the kit: sending email (the app's `deliverInvitation`), accounts and sign-in (the app's
`identify`; `koraAuthIdentity(auth)` adapts `@korajs/auth`), inviting while offline (memberships
are server writes), link invitations, Vue and Svelte hooks, member caps, organizations and nested
groups. Apps with a different membership model (enrollment after payment, staff accounts created
by a business) use `server.access` directly; the kit is optional.

## Developer experience

```typescript
// schema
import { spacesCollections } from '@korajs/spaces'
export const sharing = spacesCollections({
  roles: ['viewer', 'editor', 'admin', 'owner'], // lowest to highest; the owner role is last
  ownerRole: 'owner',                             // held only through the group's owner field
  manageRole: 'admin',                            // may invite, change roles, remove
  groups: { forms: { owner: 'ownerId' } },
})
export default defineSchema({
  version: 1,
  access: sharing.access,
  collections: {
    ...sharing.collections,
    forms: {
      fields: { title: t.string(), ownerId: t.string().stamp('userId') },
      access: { read: member('id'), create: owner('ownerId'), update: member('id', 'editor'), delete: member('id', 'owner') },
    },
  },
})

// server
import { spacesRoutes, koraAuthIdentity } from '@korajs/spaces/server'
httpRoutes: [
  spacesRoutes({
    sharing,
    ...koraAuthIdentity(auth),                                // identify + findUserByEmail
    acceptUrl: (token) => `${PUBLIC_URL}/invite#${token}`,    // fragment: never sent to servers or in Referer
    deliverInvitation: ({ email, url }) => mailer.send({ to: email, text: url }),
    describeInvitation: ({ space, invitedBy }) => ({ title: '...', inviterName: '...' }), // optional
  }),
]

// client
import { createSpaces } from '@korajs/spaces/client'
import { useMembers, useInvitations, useMyRole } from '@korajs/spaces/react'
const spaces = createSpaces(app, { headers: async () => ({ authorization: `Bearer ${await getToken()}` }) })
const members = useMembers(['forms', formId])           // owner first, then members; offline
await spaces.invite(['forms', formId], { email, role: 'editor' })
await spaces.accept(tokenFromFragment)                   // resolves once this device has the membership
```

## Model

### Roles

- `roles` are ordered lowest to highest. `spacesCollections` refuses a configuration where the
  owner role is not the highest, the manager role is not strictly below it, a role repeats, or a
  role is named `leave` (transfers use it to mean "keep no role"). Nobody may outrank the owner,
  who can act on every member.
- **The owner is the group record's owner field and nothing else.** The kit never writes a
  membership row with the owner role. A row with that role written outside the kit (a backfill,
  `server.access`) counts as the manager role, so it never creates a second owner and the owner
  can still change or remove it.
- `manageRole` and above may invite, revoke invitations, change roles and remove members. An
  actor acts only on a target whose current role is strictly below their own and grants only
  roles strictly below their own; the owner may act on anyone. The same target check covers role
  changes and removals, so a manager can neither demote nor remove a fellow manager.
- The owner role moves only by transfer. By default the previous owner keeps `manageRole`, so
  giving a space away never costs the giver their access or unsent offline edits;
  `previousOwner` names another role or `'leave'`.
- Anyone but the owner may leave (`OWNER_CANNOT_LEAVE`: transfer first).
- If an owner's account is gone, an operator runs `transferSpace(server, { sharing, space,
  toUserId })`, the same transaction as the route. Raw `server.access.transfer` knows nothing of
  the kit's rows and is not the supported path.

### Collections

| Collection | Holds | Read rule |
|---|---|---|
| `space_members` | `userId`, `group`, `role`, `invitedBy`, `joinedAt`, `expiresAt` | `memberOfKey('group', undefined, { grants: false })` |
| `space_invitations` | pending invitations: `group`, `email`, `role`, `invitedBy`, `expiresAt`, `createdAt`, `tokenVersion` | `memberOfKey('group', manageRole, { grants: false })` |
| `space_invitation_secrets` | `invitationId`, `group`, `tokenHash`, `tokenVersion`, `inviterId`, `authority`, `ownerVersion` | `serverOnly()`, never synced |

All three are written only by the kit's routes. `{ grants: false }` means a capability grant (a
share link) opens a space's content but never who is in it: members are visible to real members,
invitee emails to real managers only.

Ids are deterministic: memberships use the access engine's membership record id; invitations are
`inv_` + a hash of the space and the normalized email, so inviting the same address again re-sends
the pending invitation instead of adding a second one.

People data (names, avatars) is not the kit's. Every app already has user profiles with their own
privacy rules, and copying them would create a second source of truth to secure. Hooks return user
ids; `useMembers(space, { profile })` joins the app's own profiles.

The invitations collection holds pending invitations only: accept, decline and revoke delete the
invitation and its secret in the same transaction, so no invitee email outlives its invitation and
there is no status to keep consistent. Apps that want a history use `onEvent`. An expired
invitation remains a row until revoked, re-sent or cleared; routes and hooks treat
`expiresAt <= now` (server clock) as expired.

### Invitations

- **Token**: `<invitationId>.<32 random bytes, base64url>`. Only its SHA-256 is stored. The
  invitation is read by id and the hash compared in constant time, so no hash index is needed
  and a token names exactly one invitation. `tokenVersion` increments on every re-send, so a
  rotated token is dead even if a lookup races the rotation.
- **Binding**: accept requires a signed-in caller whose verified email equals the invited one
  (`EMAIL_NOT_VERIFIED`, `EMAIL_MISMATCH`). Nobody is ever joined automatically.
- **No demotion through invitations**: inviting an existing member or the owner is refused
  (`ALREADY_MEMBER`, at once when `findUserByEmail` is provided). Accepting while already a member
  consumes the invitation, then answers `ALREADY_MEMBER`.
- **Inviter authority**: at creation, inside the transaction, the secret row records the
  inviter's role proof (`roleOf(...).proof`: source and the delivery sequence of the role's last
  change, bound to the membership index generation) and the owner's proof (`ownerVersion`).
  Accept requires both unchanged. The index assigns a new sequence on every grant, role change,
  end and re-grant by any writer (the kit, `server.access`, the expiry sweep, a group deletion),
  and a rebuild starts a new generation, so any demotion, removal or transfer after creation kills
  the invitation, even after a later re-promotion or rejoin, with no epoch field to maintain.
- **Role changes** revoke the target's pending invitations (`invitationsRevoked` in the
  response). A promotion would also give the inviter a new proof, which is assigned only at commit
  and so cannot be re-stamped onto invitations in the same transaction; revoking fails safe.
- **Transfers** (route or `transferSpace`) remove the new owner's membership row, write the
  previous owner's row, and revoke the space's pending invitations.
- **Delivery**: `deliverInvitation` runs after the invitation commits; a failure is returned as
  `DELIVERY_FAILED` and the invitation stays pending. Without `deliverInvitation` the create route
  returns the link to the inviter (useful in development). Delivery is not queued: every pending
  invitation offers a re-send, which rotates the token, so a lost or late email is never a
  security problem.
- **Re-sending** needs the right to revoke: the sender, or a manager ranked above the invited
  role. A lower manager cannot replace a superior's invitation.

### Limits

On by default, because invitation email abuse damages every app's sender reputation and few
developers guard against it on day one. Each is configurable or `false`:

| Limit | Default |
|---|---|
| `pendingPerSpace` | 50 (best effort under concurrent invites; dead invitations are cleared when it is reached) |
| `perRecipientPerDay` (one inviter to one address) | 5 |
| `perAddressPerDay` (everyone to one address) | 20 |
| `perInviterPerDay` | 200 |
| `requestsPerUserPerMinute` | 60 |

Quotas are counted only after the early checks pass, and an invitation the transaction refuses
gives its quota back (`SpacesLimiter.release`, optional). Limits go through a `SpacesLimiter`
(`hit(key, limit, windowMs)`); the default `memoryLimiter()` is per instance and bounded in size.
A multi-instance deployment passes its own shared limiter; the kit does not ship one, since the
app owns its infrastructure.

## Routes

All `POST` with a JSON body under `basePath` (default `/api/spaces`; a root mount is refused),
so tokens never appear in URLs or access logs. Responses set `Referrer-Policy: no-referrer` and
`Cache-Control: no-store`; failures are `{ error: { code, message } }` with a code from
`SPACES_ERROR_CODES`.

| Route | Who | Decision |
|---|---|---|
| `invitations/create` `{ space, email, role }` | may grant `role` | invitation and secret upserted, `tokenVersion + 1` |
| `invitations/revoke` `{ invitationId }` | sender, or a manager above the role | invitation and secret deleted |
| `invitations/describe` `{ token }` | signed in | `{ role, expiresAt, expired, emailHint, match }`, plus `describeInvitation`'s result only when `match` is `yes`; applies accept's checks |
| `invitations/accept` `{ token }` | the invitee | unexpired, token version matches, inviter and owner proofs unchanged, not a member: membership written (with `joinedAt`), invitation and secret deleted |
| `invitations/decline` `{ token }` | the invitee | invitation and secret deleted |
| `members/role` `{ space, userId, role, from? }` | may act on target and grant `role` | membership updated (keeping its latest expiry); target's pending invitations revoked |
| `members/remove` `{ space, userId, from? }` | may act on target | membership deleted; target's invitations revoked |
| `leave` `{ space }` | a member, not the owner | membership deleted (also for a deleted space, so restoring it does not restore the member) |
| `transfer` `{ space, toUserId, previousOwner? }` | the owner | owner field updated, previous owner's row written or removed, new owner's row removed, pending invitations revoked |

Every condition is evaluated inside `kora.transaction` (reads through `tx.findById`, `tx.query`,
`tx.roleOf`), never against a read made earlier in the route: no other write, from any route,
device or server instance, commits between the reads and the commit. `from` lets a client refuse
when the target's role changed since it looked (`ROLE_CHANGED`).

Enumeration: unknown, foreign, used and revoked tokens all answer `INVITATION_NOT_FOUND`;
non-managers other than the sender get `INVITATION_NOT_FOUND` from revoke too, so it does not
reveal who is invited. `emailHint` is masked (`j***@example.com`).

Hooks: `onEvent` (one audit event per committed action, invitation events carrying the invitation
id and email; errors are logged, never returned) and `beforeInvite` (product rules such as plans
or allowed domains).

## Client

- `createSpaces(app, { basePath, headers, fetch? })`. Each call sends `headers()`. A network
  failure maps to `SpacesOfflineError`; nothing is queued.
- `accept` resolves when the caller's own `space_members` row (with `joinedAt`) is present
  locally, or after `timeoutMs` (default 10 s) with `pending: true`. It never waits for the group
  record, which the granted role may not be allowed to read.
- Hooks read the app from `<KoraProvider>`: `useMembers(space, { profile? })` (owner from the
  group record, then members by role; without read access to the group record, members without
  the owner), `useInvitations(space)` (pending and expired, managers only), and
  `useMyRole(space, userId)` (UI only; the server decides). Hooks re-render at the earliest
  expiry, and treat malformed expiries and unconfigured roles as granting nothing. They read
  through the app's pre-ready collection accessors and `app.schema`, so they render before the
  store opens (first-visit read-through) and return nothing until it has.
- Authority is checked before anything about the space or the target: someone who cannot
  manage members (invite, change roles, remove, transfer) gets `FORBIDDEN` whatever the
  space's state, so a refusal never reveals whether a space exists or who is in it. The creator
  of a space created offline that has not reached the server yet cannot be told apart from a
  stranger, so they get the same refusal; its message says to retry once it has synced. A
  manager of a deleted space gets `SPACE_NOT_FOUND`.

## Key choices

- **Caps on by default, configurable**: secure defaults are part of "it just works".
- **Previous owner keeps `manageRole`** after a transfer: giving something away should not cost
  the giver their access by surprise.
- **One package with `/server`, `/client`, `/react` entry points**: one install, one version,
  tree-shaken.
- **Owner and manager roles must differ**: one clear model (an owner, managers below).
- **Authority from the access index, not field versions**: the index records a change on every
  grant, role change, end and re-grant by any writer, while field versions would miss writes that
  end a membership by deleting its row.
- **Primitives stay in the framework**: `kora.transaction` and `access.roleOf` live in
  `@korajs/server` because an inventory, booking or ledger app needs a locked read-decide-write as
  much as sharing does. The kit keeps only what is specific to sharing.

## Security checklist

- Tokens: hash only, versioned, single use, POST only, fragment URLs, no-referrer, server clock.
- Binding: verified email; no auto-join; no link invitations.
- Escalation: strictly-below rule; owner only by transfer; all checks inside the transaction;
  inviter and owner re-checked at accept; role changes, removals and transfers revoke pending
  invitations.
- Races: role change vs remove, accept vs revoke, transfer vs leave are decided by the
  transaction, tested with concurrent requests across instances.
- Enumeration: uniform not-found; masked email hint; app details only for the matching invitee.
- Abuse: per-space pending cap, per-recipient, per-address and per-inviter daily caps, per-user
  rate; pluggable shared limiter.
- Exposure: emails readable by managers only; secrets never synced; capability grants see
  neither.

## Known limits

- **Stray owner-role rows.** A user whose role is decided by a membership row holding the owner
  role (written outside the kit) is treated as a manager but cannot send invitations, because no
  proof of their real role can be recorded, until the owner sets their role again.
- **Promotions revoke invitations** the promoted member had sent (see Invitations).
- **The pending cap is best effort** under concurrent invites; there is no member cap (that needs
  a group-level admission record serializing every accept).
- **The default limiter is per instance**; multi-instance deployments must supply a shared one.
- **React only** for hooks; Vue and Svelte apps use the client and their own queries.

## Tests

- `packages/spaces/tests/integration`: `lifecycle`, `adversarial` (escalation, enumeration,
  token reuse), `auth-verification`, `link-holders` (capability grants never reveal members or
  invitations), and `concurrency` (races across instances: two SQLite connections on one file
  and three Postgres instances).
- Unit tests: `tokens.test.ts`, `limiter.test.ts`, `spaces-collections.test.ts`,
  `spaces-client.test.ts`, `react/hooks.test.tsx`.
- `packages/test/tests/spaces-e2e.test.ts`: real devices syncing with a server that serves the
  routes: accept resolves once the member's device holds the membership, the space's records
  follow, and a removal takes them away again.
