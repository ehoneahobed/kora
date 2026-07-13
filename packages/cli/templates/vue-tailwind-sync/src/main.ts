import { createKoraAuthSync } from '@korajs/auth'
import { AuthProvider } from '@korajs/auth/vue'
import { KoraProvider } from '@korajs/vue'
import { createApp as createKoraApp } from 'korajs'
import { createApp, h } from 'vue'
import App from './App.vue'
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

const loadingFallback = h(
	'div',
	{ class: 'flex h-screen items-center justify-center bg-gray-950 text-gray-400' },
	'Loading...',
)

createApp({
	render: () =>
		h(
			AuthProvider,
			{
				client: authClient,
				fallback: h(
					'div',
					{ class: 'flex h-screen items-center justify-center bg-gray-950 text-gray-400' },
					'Restoring session...',
				),
			},
			{
				default: () =>
					h(KoraProvider, { app: kora, fallback: loadingFallback }, { default: () => h(App) }),
			},
		),
}).mount('#app')
