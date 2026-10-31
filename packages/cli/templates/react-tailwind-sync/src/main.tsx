import { KoraProvider } from '@korajs/react'
import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { app } from './kora'
import './index.css'

// The sign-in client is not on the first paint's path: the list renders from the local database.
const AuthBridge = lazy(() => import('./AuthBridge'))

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
