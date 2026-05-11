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
		auth: async () => ({
			token: (await authClient.getAccessToken()) ?? '',
		}),
	},
	store: {
		workerUrl: koraWorkerUrl,
	},
	devtools: true,
})

// Connect to sync server once the app is ready
app.ready.then(() => app.sync?.connect())
void completeOAuthCallbackFromLocation().catch((error) => {
	console.error('[Kora Auth] OAuth callback failed:', error)
})

const rootElement = document.getElementById('root')

if (!rootElement) {
	throw new Error('Root element not found')
}

createRoot(rootElement).render(
	<StrictMode>
		<AuthProvider
			client={authClient}
			fallback={
				<div className="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
					Restoring session...
				</div>
			}
		>
			<KoraProvider
				app={app}
				fallback={
					<div className="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
						Loading...
					</div>
				}
			>
				<App />
			</KoraProvider>
		</AuthProvider>
	</StrictMode>,
)
