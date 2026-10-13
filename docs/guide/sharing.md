---
title: Sharing
description: "Add email-invitation sharing to any record (a form, a document, a board) with @korajs/spaces: invitations, roles, members, leaving and transferring ownership, decided safely on the server and readable offline on every device."
---

# Sharing

`@korajs/spaces` turns records of your choice into shared spaces: their owner invites people by email, gives them roles, changes or removes them, and can transfer the space; members can leave. It sits on [access rules](/guide/access-rules), so a member's devices receive the space's records and lose them when they are removed, and the member list and pending invitations are ordinary synced data you can render offline.

::: warning Experimental in the beta.15 canaries
Sharing needs access rules, which are behind `experimentalAccessRules` on the server until they have run in real apps.
:::

Every action is one server transaction: its checks (the caller's role, the target's, the invitation's token, the inviter's authority) and its writes commit together, so no concurrent request, device upload or other server instance can slip between them. The trust-boundary parts (tokens, escalation, races, enumeration) are written and tested once, in the kit.

## 1. Schema

<!-- docs-check-prelude
import { defineSchema, member, owner, t } from 'korajs'
-->

```typescript
import { spacesCollections } from '@korajs/spaces'

export const sharing = spacesCollections({
  roles: ['viewer', 'editor', 'admin', 'owner'], // lowest to highest; the owner role last
  ownerRole: 'owner', // held only through the record's owner field
  manageRole: 'admin', // may invite, change roles and remove
  groups: { forms: { owner: 'ownerId' } },
})

export const schema = defineSchema({
  version: 1,
  access: sharing.access,
  collections: {
    ...sharing.collections,
    forms: {
      fields: { title: t.string(), ownerId: t.string().stamp('userId') },
      access: {
        read: member('id'),
        create: owner('ownerId'),
        update: member('id', 'editor'),
        delete: member('id', 'owner'),
      },
    },
  },
})
```

`sharing.collections` adds three collections, all written only by the kit's routes:

| Collection | Holds | Who receives it |
|---|---|---|
| `space_members` | `userId`, `group`, `role`, `invitedBy` | every member of the space |
| `space_invitations` | pending invitations: `email`, `role`, `invitedBy`, `expiresAt` | the space's managers |
| `space_invitation_secrets` | token hashes and the inviter's authority | nobody (server only) |

A shared collection's read rule must admit every member (`member('id')` does): being in a space and not seeing it is not a model the kit supports.

## 2. Server

<!-- docs-check-prelude
import type { Sharing } from '@korajs/spaces'
declare const sharing: Sharing
declare const auth: import('@korajs/auth/server').KoraAuthServer
declare const mailer: { send(message: { to: string; subject: string; text: string }): Promise<void> }
-->

```typescript
import { koraAuthIdentity, spacesRoutes } from '@korajs/spaces/server'

const routes = spacesRoutes({
  sharing,
  ...koraAuthIdentity(auth), // who is calling, and email lookups (refuses inviting an existing member early)
  acceptUrl: (token) => `https://app.example.com/invite#${token}`,
  deliverInvitation: async ({ email, url, role }) => {
    await mailer.send({ to: email, subject: `You're invited as ${role}`, text: url })
  },
})
// createProductionServer({ ..., httpRoutes: [routes] })
```

Put the token in the URL fragment (`#`), as above: fragments are never sent to servers or in `Referer` headers. Without `@korajs/auth`, pass `identify(request)` returning `{ userId, email, emailVerified }` or null.

| Option | |
|---|---|
| `basePath` | Where the routes live (default `/api/spaces`). |
| `deliverInvitation` | Your mailer. Runs after the invitation is committed; a failure answers `DELIVERY_FAILED` and the invitation stays pending (re-send it). Without it, the create route returns the link to the inviter. |
| `describeInvitation` | What the accept page may show (`{ title, inviterName }`). Called only for a signed-in caller whose verified email is the invited one. |
| `beforeInvite` | Product rules (plans, allowed domains): return `{ message }` to refuse. |
| `onEvent` | Audit log: one event per committed action (`invitation.created`, `invitation.accepted`, `member.removed`, `space.transferred`, ...). |
| `invitationTtlMs` | How long an invitation is valid (default 7 days). |
| `limits` | `pendingPerSpace` (50), `perRecipientPerDay` (5 invitations from one user to one address, across all spaces), `perInviterPerDay` (200), `requestsPerUserPerMinute` (60). `false` turns one off. Refused invitations do not count. |
| `limiter` | Counts requests for the limits. The default is in memory per instance; with several instances, pass one backed by shared storage. |

## 3. Client

<!-- docs-check-prelude
import type { SpacesAppLike } from '@korajs/spaces/client'
declare const app: SpacesAppLike
declare function getAccessToken(): Promise<string>
declare const formId: string
-->

```typescript
import { createSpaces } from '@korajs/spaces/client'

const spaces = createSpaces(app, {
  headers: async () => ({ authorization: `Bearer ${await getAccessToken()}` }),
})

await spaces.invite(['forms', formId], { email: 'bob@example.com', role: 'editor' })

// On the accept page (/invite#<token>):
const token = window.location.hash.slice(1)
const invitation = await spaces.describe(token) // { role, expiresAt, expired, emailHint, match, details? }
const accepted = await spaces.accept(token) // resolves once this device holds the membership
```

`accept` resolves once the new membership has reached the device (so the space's records are on their way), or after `timeoutMs` (10 s) with `pending: true`. The other actions: `revokeInvitation`, `decline`, `changeRole`, `remove`, `leave` and `transfer`. Sharing changes are server decisions: offline, they throw `SpacesOfflineError` and nothing is queued. Refusals throw `SpacesError` with a stable `code`.

## 4. React

<!-- docs-check-prelude
declare const formId: string
declare const currentUserId: string
declare const profiles: Map<string, { name: string }>
-->

```tsx
import { useInvitations, useMembers, useMyRole } from '@korajs/spaces/react'

function Members() {
  const members = useMembers(['forms', formId], { profile: (id) => profiles.get(id) })
  const invitations = useInvitations(['forms', formId]) // managers only; others get []
  const role = useMyRole(['forms', formId], currentUserId)
  return (
    <ul>
      {members.map((m) => (
        <li key={m.userId}>
          {m.profile?.name ?? m.userId} ({m.role})
        </li>
      ))}
      {role === 'admin' || role === 'owner'
        ? invitations.map((i) => <li key={i.id}>{i.email}: invited{i.expired ? ', expired' : ''}</li>)
        : null}
    </ul>
  )
}
```

The hooks read the local store inside `<KoraProvider app={app}>`: they work offline and update as memberships sync. Members are user ids, owner first; join your own profiles with `profile`. `useMyRole` is for showing and hiding controls; the server decides every action.

## Who may do what

- **Invite, change roles, remove:** at least `manageRole`, and only below yourself: you grant only roles strictly below your own, and act only on members whose role is strictly below yours. A manager can neither demote nor remove another manager; the owner can act on everyone.
- **The owner** is the record's owner field and nothing else. The owner role is never granted by invitation or role change, only by `transfer`. After a transfer the previous owner keeps `manageRole` by default (`previousOwner` chooses another role, or `'leave'`), so nobody loses access or unsent edits by giving a space away.
- **Leave:** any member but the owner, who transfers first (`OWNER_CANNOT_LEAVE`). Members can also leave a deleted space, so restoring it does not bring them back.
- **Role changes keep a membership's expiry**, so access granted until a date (with `server.access.grant`) stays time-limited.
- A membership row holding the owner role, written outside the kit (a backfill, `server.access.grant`), counts as the manager role in the kit's routes: it never makes a second owner, and the owner can change or remove it. Give the owner role only with `transfer`.
- **Accept:** a signed-in user whose verified email is the invited address. An invitation never changes an existing member's role: it is consumed and answers `ALREADY_MEMBER`.

## Invitations

- A token is 32 random bytes; only its SHA-256 is stored, server-side. Re-inviting the same address re-sends the pending invitation with a new token: the previous link stops working.
- An invitation records the inviter's role as it was when it was sent. If the inviter is demoted, removed (even if added back), or the space changes owner (by the kit, an operator or `server.access.transfer`), the invitation stops working (`INVITER_NO_LONGER_AUTHORIZED`). Changing a member's role, removing them or their leaving also revokes their pending invitations, and a transfer revokes all of the space's.
- Unknown, malformed, re-sent, revoked and used tokens all answer `INVITATION_NOT_FOUND`. Before accepting, an invitee sees the role, the expiry and a masked address (`b***@example.com`); names come only from `describeInvitation`, and only for the verified invitee.
- Accepted, declined and revoked invitations are deleted with their secret. Expired ones stay listed (flagged) until revoked or re-sent. Invitations whose sender lost their role outside the kit stay listed until the space reaches its pending limit, when they are cleared.
- Re-sending an invitation someone else sent needs the right to revoke it (its sender, or a manager above the invited role). Only managers and the sender learn whether an invitation exists.

## Operators

When an owner's account is gone, transfer the space from a script:

<!-- docs-check-prelude
import type { Sharing } from '@korajs/spaces'
declare const sharing: Sharing
declare const server: { kora: import('@korajs/server').ProductionHttpRouteContext; access: import('@korajs/server').AccessApi }
-->

```typescript
import { transferSpace } from '@korajs/spaces/server'

await transferSpace(server, { sharing, space: ['forms', 'f1'], toUserId: 'admin-user-id' })
```

It runs the same transaction as the route (removing the new owner's membership row, keeping the previous owner as a manager or not, revoking pending invitations). Use it rather than `server.access.transfer`, which knows nothing of the kit's rows.

## Error codes

Responses are `{ error: { code, message } }`; `message` is written for people.

| Code | Status | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No signed-in user. |
| `FORBIDDEN` | 403 | The caller's role does not allow this action on this target. |
| `ROLE_TOO_HIGH` | 403 | Granting a role at or above your own. |
| `ROLE_NOT_ALLOWED` | 400 | Not a role, or the owner role (transfer instead). |
| `ROLE_CHANGED` | 409 | The member's role is no longer the `from` you saw. |
| `SPACE_NOT_SYNCED` | 409 | The server does not have the space yet (created offline); retry after it syncs. |
| `SPACE_NOT_FOUND` | 404 | The space was deleted. |
| `NOT_A_MEMBER`, `ALREADY_MEMBER`, `ALREADY_OWNER` | 404, 409, 409 | |
| `CANNOT_CHANGE_OWNER`, `OWNER_CANNOT_LEAVE` | 409 | The owner changes only by transfer. |
| `INVITATION_NOT_FOUND`, `INVITATION_EXPIRED` | 404, 410 | |
| `INVITER_NO_LONGER_AUTHORIZED` | 409 | The inviter's role or the space's owner changed since it was sent. |
| `EMAIL_MISMATCH`, `EMAIL_NOT_VERIFIED` | 403 | Signed in with another address, or an unverified one. |
| `TOO_MANY_PENDING`, `RATE_LIMITED` | 429 | A limit. |
| `INVITE_REFUSED` | 403 | `beforeInvite` refused. |
| `DELIVERY_FAILED` | 502 | Saved but not sent; re-send. |
| `CONFLICT` | 503 | Lost a race the server could not retry; try again. |

## When not to use the kit

The kit is for people inviting people. When membership follows another source of truth (enrollment after a payment, staff accounts created by a business, a directory sync), write memberships with [`server.access`](/guide/access-rules#changing-who-belongs-where) or `backfill` instead, and render them with the same hooks if you use the kit's collections.
