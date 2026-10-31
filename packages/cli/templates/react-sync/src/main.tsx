import { createKoraAuthSync } from '@korajs/auth'
import { AuthProvider } from '@korajs/auth/react'
import { KoraProvider } from '@korajs/react'
import { createApp } from 'korajs'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { authClient, completeOAuthCallbackFromLocation } from './auth'
import schema from './schema'
import './index.css'
import koraWorkerUrl from './kora-worker.ts?worker&url'

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
		authClient: createKoraAuthSync({ authClient, schema }),
	},
	store: {
		workerUrl: koraWorkerUrl,
	},
	devtools: import.meta.env.DEV,
})

// Start connecting now: the socket opens while the local database does (no need to wait for app.ready)
void app.sync?.connect()
void completeOAuthCallbackFromLocation().catch((error) => {
	console.error('[Kora Auth] OAuth callback failed:', error)
})

const rootElement = document.getElementById('root')

if (!rootElement) {
	throw new Error('Root element not found')
}

createRoot(rootElement).render(
	<StrictMode>
		<AuthProvider client={authClient} fallback={<div>Restoring session...</div>}>
			<KoraProvider app={app}>
				<App />
			</KoraProvider>
		</AuthProvider>
	</StrictMode>,
)
