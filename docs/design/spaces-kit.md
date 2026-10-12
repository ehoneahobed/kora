# Design: `@korajs/spaces`, sharing on top of access rules

Status: proposal for review (Codex plus an independent review before code). Date: 2026-10-12.
Depends on: access rules (`docs/guide/access-rules.md`), merged in steps 1 to 6.

## 1. Problem

Access rules decide who may read and write a group once memberships exist. Every app that shares
still has to build the product around them, and our own apps show what that costs:

- koraforms wrote a `form_collaborators` collection, four routes (invite, accept, change role,
  remove/leave), token generation, email-match checks, rate limits, audit events, a backfill at
  startup and the glue to `server.access` (about 400 lines in `server.ts` plus UI state).
- koradocs needs the same for documents, korapos for branches (staff), the LMS for courses
  (enrollment).

The hard parts are the same each time and sit on the trust boundary: invitation tokens, who may
invite with which role, matching the invitee to a verified identity, the last owner leaving, and
telling a user what happened to edits made in a group they lost. A mistake is an account takeover
or a data leak. They should be written and red-teamed once.

## 2. Goals and non-goals

Goals:
- An app adds sharing to a group collection (documents, forms, courses, branches) in under 50
  lines: a schema fragment, a route list, and hooks.
- Invite by email, accept, decline, revoke an invitation, change a role, remove a member, leave,
  transfer ownership. Every action is a server write under the access engine, so it is in the
  log, synced, and effective at once.
- The member list and pending invitations are synced data: readable offline, reactive in
  `useQuery`, with no extra endpoint.
- "Your removed edits": what the user lost when access ended, exportable.
- Optional. Apps that need another model keep using `server.access` directly.

Non-goals:
- Sending email. The kit calls the app's `deliverInvitation` with a URL; the app owns
  providers, templates and locales.
- User accounts and sign-in. The kit asks the app who the caller is (`identify`). An adapter for
  `@korajs/auth` ships in the kit.
- Inviting while offline. Invitations are server writes (a membership cannot be granted by a
  device). The client API fails fast with `SpacesOfflineError`; the UI can disable the button
  with `useSyncStatus`.
- Organizations (`@korajs/auth` org) and nested groups (group of groups). Out of scope; see 9.

## 3. Developer experience

Schema (one fragment per app, merged into `defineSchema`):

```typescript
import { defineSchema, t, member, owner } from 'korajs'
import { spacesCollections } from '@korajs/spaces'

const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const
const sharing = spacesCollections({ roles: ROLES, groups: { forms: { owner: 'ownerId' } } })

export default defineSchema({
  version: 21,
  access: sharing.access,                 // memberships: 'space_members', roles, groups
  collections: {
    ...sharing.collections,               // space_members, space_invitations
    forms: {
      fields: { title: t.string(), ownerId: t.string().stamp('userId') },
      access: { read: member('id'), create: owner('ownerId'), update: member('id', 'editor'), delete: member('id', 'owner') },
    },
  },
})
```

Server (routes are ordinary `httpRoutes`):

```typescript
import { spacesRoutes, koraAuthIdentity } from '@korajs/spaces/server'

const server = createProductionServer({
  schema,
  httpRoutes: [
    ...authRoutes,
    spacesRoutes({
      basePath: '/api/spaces',
      identify: koraAuthIdentity(userStore, tokenVerifier), // { userId, email, emailVerified } | null
      inviteUrl: (token) => `${PUBLIC_URL}/invite/${token}`,
      deliverInvitation: async ({ email, url, inviterName, group, role }) => mailer.send(/* ... */),
      maxMembers: 50,                       // per group, optional
    }),
  ],
})
```

Client:

```typescript
import { createSpaces } from '@korajs/spaces/client'
import { useMembers, useInvitations, useRemovedEdits } from '@korajs/spaces/react'

const spaces = createSpaces(app, { basePath: '/api/spaces' })

function Sharing({ formId }: { formId: string }) {
  const group = ['forms', formId] as const
  const members = useMembers(app, group)          // synced rows, works offline
  const invitations = useInvitations(app, group)  // pending, managers only
  return (
    <>
      <button onClick={() => spaces.invite(group, { email, role: 'editor' })}>Invite</button>
      {members.map((m) => <Member key={m.userId} m={m} onRemove={() => spaces.remove(group, m.userId)} />)}
    </>
  )
}

// Accept page (/invite/:token)
await spaces.accept(token)          // returns { group }, then the group syncs to this device
```

## 4. Model

### 4.1 Collections (produced by `spacesCollections`)

| Collection | Fields | Read | Write |
|---|---|---|---|
| `space_members` (the memberships collection) | `userId`, `group`, `role`, `expiresAt?`, `displayName?`, `email?` | `memberOfKey('group')` (members see the member list; open question 10.3 of the access design, answered yes) | server only |
| `space_invitations` | `group`, `email`, `role`, `invitedBy`, `status` (`pending`, `accepted`, `declined`, `revoked`, `expired`), `expiresAt`, `createdAt` | `memberOfKey('group', manageRole)` | server only |
| `space_invitation_secrets` | `invitationId`, `tokenHash` | `serverOnly()` (never synced) | server only |

- The token itself is never stored: `tokenHash = sha256(token)` lives in a collection no client
  reads, written in the same conditional set as the invitation (7.1 explains why not a field
  read rule).
- `displayName` and `email` on members are copied at accept time from the identity, so the member
  list renders offline without a user directory. The email is shown to fellow members only (the
  read rule). An app that must not show emails sets `memberProfile: 'name-only'`.
- Ids are deterministic: a membership record is `membershipRecordId(userId, group)` (as in
  `server.access`), an invitation is `inv_` + hash(group, normalized email), so a re-invite
  replaces the pending invitation instead of creating a second one (the koraforms unique
  constraint, without a constraint).

### 4.2 Roles and permissions

- `roles` are ordered lowest to highest; the last one is the owner role (`groups[c].role`).
- `manageRole` (default: the role just below owner, else owner) may invite, revoke invitations,
  change roles and remove members.
- Nobody grants a role above their own; only the owner grants `manageRole`; the owner role moves
  only by `transfer`.
- A member may always leave, except the owner (transfer first: `OWNER_CANNOT_LEAVE`).
- Removing a member with a role equal to or above your own is refused unless you are the owner.

Every rule above is checked in the route against the index at decision time
(`request.access` reads), never against client-sent data.

### 4.3 Invitations

- Token: 32 random bytes, base64url, single use, default lifetime 7 days (`invitationTtlMs`).
- Accept requires a signed-in caller whose `identify()` email equals the invitation email and is
  verified (`emailVerified: true`). An unverified email gets `EMAIL_NOT_VERIFIED`, never the
  group. Same rule as `@korajs/auth` org invitations.
- Accept is one conditional server write (`applyConditional`): the invitation must still be
  `pending` and unexpired when the store decides, and the membership is written in the same set.
  Two concurrent accepts cannot both succeed; an accept racing a revoke loses cleanly.
- `link` invitations (anyone with the link, no email) are opt-in per call
  (`invite(group, { link: true, role })`), capped at `viewer`-level roles by default
  (`maxLinkRole`), and expire. Off by default: a forwarded link is a sharing decision the app must
  make on purpose.
- Re-invite of a pending address rotates the token (the old link stops working).
- Invitations to an address that already has an account still go by email; the kit never
  auto-joins anyone.

## 5. Routes (`spacesRoutes`)

All under `basePath`, JSON, authenticated via `identify`, rate limited per user
(`rateLimit`, default 30 invites and 60 other actions per minute, in memory per instance; an
app with several instances passes a shared limiter).

| Route | Who | Effect |
|---|---|---|
| `POST /invitations` `{ group, email, role, link? }` | `manageRole` | upsert invitation, call `deliverInvitation`; returns `{ invitationId }` (the token only for link invitations) |
| `POST /invitations/:id/revoke` | `manageRole` | status `revoked` |
| `GET /invitations/by-token/:token` | anyone signed in | `{ group, role, inviterName, expiresAt, emailHint }` for the accept page; never the full email |
| `POST /invitations/accept` `{ token }` | the invitee | conditional write: membership plus status `accepted` |
| `POST /invitations/decline` `{ token }` | the invitee | status `declined` |
| `POST /members/role` `{ group, userId, role }` | `manageRole` | `server.access.grant` with the new role |
| `POST /members/remove` `{ group, userId }` | `manageRole` | `server.access.revoke` |
| `POST /leave` `{ group }` | any member but the owner | `server.access.revoke` (self) |
| `POST /transfer` `{ group, toUserId }` | owner | `server.access.transfer` (the new owner must already be a member) |

Errors are `{ error: { code, message } }` with stable codes (`NOT_A_MEMBER`, `ROLE_TOO_HIGH`,
`OWNER_CANNOT_LEAVE`, `INVITATION_NOT_FOUND`, `INVITATION_EXPIRED`, `EMAIL_MISMATCH`,
`EMAIL_NOT_VERIFIED`, `MEMBER_LIMIT`, `RATE_LIMITED`). Unknown or foreign invitation ids and
tokens all answer `INVITATION_NOT_FOUND` (no probing).

Hooks for the app: `onEvent({ type, group, actorId, ... })` for audit logs (koraforms writes
`audit_events` from it), `beforeInvite(ctx)` to add product limits (plans, domains).

## 6. Client

- `createSpaces(app, { basePath, fetch? })`: `invite`, `revokeInvitation`, `accept`, `decline`,
  `describeInvitation`, `changeRole`, `remove`, `leave`, `transfer`. Each sends the app's auth
  header (from `sync.auth` or `authClient`) and throws `SpacesError` with the server code.
  Offline: `SpacesOfflineError` at once, no queue (membership changes are not optimistic).
- After `accept`, the server's re-scope delivers the group; `spaces.accept` resolves when the
  group record is present locally (or after `timeoutMs`, default 10 s, with `{ syncing: true }`).
- Hooks (`@korajs/spaces/react`, Vue and Svelte equivalents): `useMembers(app, group)`,
  `useInvitations(app, group)`, `useMyRole(app, group)` (from the synced membership, for UI only;
  the server decides), `useRemovedEdits(app)`.
- **Removed edits.** `useRemovedEdits` lists rejected operations whose code is `ACCESS_DENIED`,
  `SCOPE_RETRACTED` or `SERVER_OWNED`, grouped by group when the record names one, with
  `exportRemovedEdits()` producing JSON the user can download. Copy guidance in the docs:
  "removed from your workspace", never "deleted".

## 7. Framework changes the kit needs

1. **No field read rules.** Today rules gate whole records for reading; hiding one field
   (`tokenHash`) would need the download path to strip fields from operations and scope entries,
   which is new trust-boundary work. The kit instead splits the secret into a collection with
   `read: serverOnly()` (4.1), written in the same conditional set. Field read rules can come
   later (useful beyond the kit: internal notes, payout fields) without changing the kit's API.
2. `applyConditional` with an `also` set that includes a memberships write: already supported
   (sweeper uses it); add a test that the derived interval opens in the same transaction.
3. `request.principal` on custom routes is not needed: `identify` stays app-provided, so the
   kit works with any auth.

## 8. Security review checklist

- Token: never stored in clear, never synced, compared by hash in constant time, single use,
  rotated on re-invite, expired by the server clock.
- Invitee binding: verified email only; link invitations opt-in, role-capped, expiring.
- Escalation: no grant above the actor's role; owner role only by transfer; checks read the
  index at decision time; concurrent role changes resolve as ordinary server writes in order.
- Enumeration: uniform `INVITATION_NOT_FOUND`; `describeInvitation` returns an email hint
  (`j***@example.com`) only.
- Abuse: rate limits per user; `maxMembers`; `deliverInvitation` failures do not leave an
  invisible pending invitation (status is written first, delivery failure is returned to the
  inviter, who can resend).
- Data exposure: member emails readable by fellow members only (configurable off); invitation
  rows by managers only.
- Removal: revocation flows through the engine (retraction with the unsent-edits path); the kit
  adds nothing that bypasses it.

## 9. Fit across our apps

| App | Group | Roles | Notes |
|---|---|---|---|
| koraforms | `forms` | viewer, editor, admin, owner | replaces `form_collaborators`, four routes, backfill: target under 60 lines of app code |
| koradocs | `documents` | view, comment, edit, manage | adds `link` invitations for read-only sharing |
| korapos | `branches` | cashier, manager, owner | invitations from the owner's dashboard; staff accounts created by the app |
| LMS | `courses` | learner, instructor | enrollment comes from payment, not invitations: uses `server.access` (or `backfill`) directly and only the hooks |

The LMS row is the check that the kit stays optional: everything it does is reachable through
the engine without the kit.

## 10. Open questions

1. The secret in a separate server-only collection (7.1, recommended for beta.15), or field
   read rules now?
2. Member emails visible to fellow members by default, or names only?
3. Link invitations in the first release, or later?
4. Package layout: one package with `/server`, `/client`, `/react`, `/vue`, `/svelte` entry
   points (recommended; the server entry depends on `@korajs/server` as a peer), or separate
   packages?

## 11. Effort

| Part | Days |
|---|---|
| Schema fragment, projection, deterministic ids | 1 |
| Routes, permission checks, conditional accept, rate limits, events | 2 |
| Client API, React hooks (Vue and Svelte after), removed edits | 1.5 |
| `@korajs/auth` identity adapter | 0.5 |
| Adversarial tests (escalation, token, races, enumeration), koraforms migration | 2 |
| Docs and a template recipe | 1 |

About 8 days, then koraforms moves to it on a canary.
