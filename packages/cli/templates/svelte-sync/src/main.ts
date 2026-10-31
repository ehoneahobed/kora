import { createApp as createKoraApp, lazyAuthSync } from 'korajs'
import { mount } from 'svelte'
import Root from './Root.svelte'
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
		// The sign-in client loads after the first paint; sync waits for it, the screen does not.
		authClient: lazyAuthSync(() => import('./auth').then((m) => m.authSync)),
	},
	store: {
		workerUrl: koraWorkerUrl,
	},
	devtools: import.meta.env.DEV,
})

void kora.sync?.connect()

mount(Root, { target: document.getElementById('app')!, props: { kora } })
