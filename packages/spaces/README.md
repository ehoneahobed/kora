# @korajs/spaces

Sharing for [Kora.js](https://github.com/ehoneahobed/kora) apps: email invitations, roles, members, leaving and transferring ownership, on top of access rules.

```typescript
import { spacesCollections } from '@korajs/spaces'            // schema fragment
import { spacesRoutes, koraAuthIdentity } from '@korajs/spaces/server'
import { createSpaces } from '@korajs/spaces/client'
import { useMembers, useInvitations, useMyRole } from '@korajs/spaces/react'
```

Every action is one server transaction, so checks and writes commit together across concurrent requests and server instances. Members and pending invitations are synced data: readable offline, reactive.

Guide: [Sharing](https://korajs.dev/guide/sharing).
