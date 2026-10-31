import { KoraProvider } from '@korajs/react'
import { createApp, lazyAuthSync } from 'korajs'
import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import schema from './schema'
import './index.css'
import koraWorkerUrl from './kora-worker.ts?worker&url'

// The sign-in client is not on the first paint's path: the list renders from the local database.
const AuthBridge = lazy(() => import('./AuthBridge'))

// Build sync URL: use env var if set, otherwise derive from current page host.
// This allows the Vite proxy (/kora-sync → ws://localhost:3001) to work in dev,
// and also works through any tunnel (ngrok, cloudflared) without extra configuration.
const syncUrl =
	import.meta.env.VITE_SYNC_URL ||
	`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/kora-sync`

const app = createApp({
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

// Start connecting now: the socket opens while the local database does (no need to wait for app.ready)
void app.sync?.connect()

const rootElement = document.getElementById('root')

if (!rootElement) {
	throw new Error('Root element not found')
}

createRoot(rootElement).render(
	<StrictMode>
		<KoraProvider app={app}>
			<App />
			<Suspense fallback={null}>
				<AuthBridge />
			</Suspense>
		</KoraProvider>
	</StrictMode>,
)
