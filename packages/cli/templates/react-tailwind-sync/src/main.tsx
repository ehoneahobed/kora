import { AuthProvider } from '@korajs/auth/react'
import { KoraProvider } from '@korajs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { authClient, completeOAuthCallbackFromLocation } from './auth'
import { app } from './kora'
import './index.css'

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
		<AuthProvider
			client={authClient}
			fallback={
				<div className="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
					Restoring session...
				</div>
			}
		>
			<KoraProvider app={app}>
				<App />
			</KoraProvider>
		</AuthProvider>
	</StrictMode>,
)
