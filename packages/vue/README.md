# @korajs/vue

Vue 3 composables for [Kora.js](https://korajs.dev) offline-first applications.

## Install

```bash
pnpm add korajs@beta @korajs/vue@beta
```

## Setup

Create the Kora app once at module scope, connect sync, then wrap your tree in `KoraProvider`. This follows the CLI `vue-tailwind-sync` template:

<!-- docs-check: skip template excerpt: imports the project's own auth, schema and component modules -->
```typescript
import { KoraProvider } from '@korajs/vue'
import { createApp as createKoraApp, lazyAuthSync } from 'korajs'
import { createApp, defineAsyncComponent, h } from 'vue'
import App from './App.vue'
import schema from './schema'
import koraWorkerUrl from './kora-worker.ts?worker&url'

// The sign-in UI is not on the first paint's path: the screen renders from the local database.
const AuthBridge = defineAsyncComponent(() => import('./AuthBridge'))

const kora = createKoraApp({
  schema,
  sync: {
    url: import.meta.env.VITE_SYNC_URL,
    // The sign-in client loads after the first paint; sync waits for it, the screen does not.
    authClient: lazyAuthSync(() => import('./auth').then((m) => m.authSync)),
  },
  store: { workerUrl: koraWorkerUrl },
})

void kora.sync?.connect()

createApp({
  render: () => h(KoraProvider, { app: kora }, { default: () => [h(App), h(AuthBridge)] }),
}).mount('#app')
```

`./auth` exports `authSync = createKoraAuthSync({ authClient, schema })`. `AuthBridge` mounts `AuthProvider` from `@korajs/auth/vue` around the sign-in UI. `connect()` can be called at once: the request is remembered, and the socket opens while the local store does, once the sign-in client has loaded.

In an SFC:

```vue
<KoraProvider :app="kora">
  <TodoList />
</KoraProvider>
```

## Composables

| Composable | Purpose |
|------------|---------|
| `useQuery(query)` | Reactive local query results |
| `useMutation(fn)` | Optimistic mutations with rollback |
| `useSyncStatus()` | Connection / sync state |
| `useApp<typeof app>()` | The `createApp()` instance (the type argument types its collections) |
| `useCollection(name)` | Collection accessor |
| `useRichText(name, id, field)` | Yjs richtext editor binding |
| `usePresence(user)` | Publish collaborative presence |
| `useCollaborators()` | Remote collaborator awareness states |

```vue
<script setup lang="ts">
import { useApp, useQuery, useMutation } from '@korajs/vue'
import type { app as koraApp } from './kora'

const app = useApp<typeof koraApp>()
const todos = useQuery(app.todos.where({ completed: false }))
const { mutate: addTodo } = useMutation(app.todos.insert)
</script>

<template>
  <ul>
    <li v-for="todo in todos" :key="todo.id">{{ todo.title }}</li>
  </ul>
  <button @click="addTodo({ title: 'New' })">Add</button>
</template>
```

## Organization auth

When using `@korajs/auth` organizations, wrap with `OrgProvider` and use org composables from `@korajs/auth/vue`:

```vue
<OrgProvider :client="orgClient">
  <AdminPanel />
</OrgProvider>
```

## Legacy helpers

`installKora()` and `useKoraApp()` remain for app-context only. Prefer `KoraProvider` + composables for reactive data.
