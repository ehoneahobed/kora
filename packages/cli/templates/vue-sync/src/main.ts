import { KoraProvider } from '@korajs/vue'
import { createApp as createKoraApp, lazyAuthSync } from 'korajs'
import { createApp, defineAsyncComponent, defineComponent, h } from 'vue'
import App from './App.vue'
import { failAuth } from './auth-state'
import schema from './schema'
import './index.css'
import koraWorkerUrl from './kora-worker.ts?worker&url'

// The sign-in client is not on the first paint's path: the list renders from the local database.
const AuthBridge = defineAsyncComponent({
	loader: () => import('./AuthBridge'),
	// A failed load must not take the app down: the screen is told, nothing renders.
	errorComponent: defineComponent({
		setup() {
			console.error('[Kora Auth] The sign-in client did not load; the app keeps working offline.')
			failAuth()
			return () => null
		},
	}),
})

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

createApp({
	render: () => h(KoraProvider, { app: kora }, { default: () => [h(App), h(AuthBridge)] }),
}).mount('#app')
