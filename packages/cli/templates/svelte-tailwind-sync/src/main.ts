import { createKoraAuthSync } from '@korajs/auth'
import { createApp as createKoraApp } from 'korajs'
import { mount } from 'svelte'
import Root from './Root.svelte'
import { authClient, completeOAuthCallbackFromLocation } from './auth'
import schema from './schema'
import './index.css'
import koraWorkerUrl from './kora-worker.ts?worker&url'

const syncUrl =
	import.meta.env.VITE_SYNC_URL ||
	`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/kora-sync`

const kora = createKoraApp({
	schema,
	sync: {
		url: syncUrl,
		authClient: createKoraAuthSync({ authClient, schema }),
	},
	store: {
		workerUrl: koraWorkerUrl,
	},
	devtools: true,
})

kora.ready.then(() => kora.sync?.connect())

void completeOAuthCallbackFromLocation().catch((error) => {
	console.error('[Kora Auth] OAuth callback failed:', error)
})

mount(Root, { target: document.getElementById('app')!, props: { kora, authClient } })
