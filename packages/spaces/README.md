# @korajs/spaces

Sharing for [Kora.js](https://github.com/ehoneahobed/kora) apps: email invitations, roles, members, leaving and transferring ownership, on top of access rules.

```typescript
import { spacesCollections } from '@korajs/spaces'            // schema fragment
import { spacesRoutes, koraAuthIdentity } from '@korajs/spaces/server'
import { createSpaces } from '@korajs/spaces/client'
import { useMembers, useInvitations, useMyRole } from '@korajs/spaces/react'
```

Every action is one server transaction, so checks and writes commit together across concurrent requests and server instances. Members and pending invitations are synced data: readable offline, reactive. They sync to real members only (invitations to real managers only): a capability grant such as a share link opens a space's records, never who is in it.

Guide: [Sharing](https://korajs.dev/guide/sharing).
