import { createKoraAuthSync } from '@korajs/auth'
import { createApp } from 'korajs'
import { createKoraHooks } from 'korajs/react'
import { authClient } from './auth'
import koraWorkerUrl from './kora-worker.ts?worker&url'
import schema from './schema'

// Build sync URL: use env var if set, otherwise derive from current page host.
// This allows the Vite proxy (/kora-sync → ws://localhost:3001) to work in dev,
// and also works through any tunnel (ngrok, cloudflared) without extra configuration.
const syncUrl =
	import.meta.env.VITE_SYNC_URL ||
	`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/kora-sync`

export const app = createApp({
	schema,
	sync: {
		url: syncUrl,
		authClient: createKoraAuthSync({ authClient, schema }),
	},
	store: {
		workerUrl: koraWorkerUrl,
	},
	devtools: import.meta.env.DEV,
})

/** The typed `todos` collection: inserts, updates and queries are checked against the schema. */
export type Todos = typeof app.todos

// Hooks bound to this app's schema: `useCollection('todoz')` is a type error, and the
// rows `useQuery` returns are typed from the query.
export const { useCollection, useQuery, useMutation, useSyncStatus } = createKoraHooks<typeof app>()
