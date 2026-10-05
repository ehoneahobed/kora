import { AuthProvider } from '@korajs/auth/react'
import { KoraProvider } from '@korajs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { authClient, completeOAuthCallbackFromLocation } from './auth'
import { app } from './kora'
import './index.css'

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
