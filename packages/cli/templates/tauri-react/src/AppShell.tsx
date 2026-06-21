import { createKoraAuthSync } from '@korajs/auth'
import { AuthProvider } from '@korajs/auth/react'
import { KoraProvider } from '@korajs/react'
import { createApp } from 'korajs'
import { useCallback, useEffect, useState } from 'react'
import { App } from './App'
import { SetupScreen } from './SetupScreen'
import { completeOAuthCallbackFromLocation, createDesktopAuthClient } from './auth'
import schema from './schema'
import {
	clearSyncUrl,
	factoryReset,
	getSyncUrl,
	hasCompletedSetup,
	markSetupComplete,
	setSyncUrl,
} from './sync-config'
import { checkForUpdates } from './updater'

type AppState = { phase: 'setup' } | { phase: 'running'; syncUrl: string | null }

/**
 * Root component that handles the first-launch setup flow.
 *
 * - If setup not completed, shows the setup screen.
 * - If completed, initializes Kora and renders the app.
 * - Handles server changes with proper data isolation warnings.
 *
 * Changing the sync server requires an app restart (to re-create the
 * Kora app instance with the new URL). This is intentional — it prevents
 * partial state from one server leaking to another.
 */
export function AppShell() {
	const [state, setState] = useState<AppState>(() => {
		if (hasCompletedSetup()) {
			return { phase: 'running', syncUrl: getSyncUrl() }
		}
		return { phase: 'setup' }
	})

	const handleConnect = useCallback((url: string) => {
		setSyncUrl(url)
		setState({ phase: 'running', syncUrl: url })
	}, [])

	const handleSkip = useCallback(() => {
		markSetupComplete()
		setState({ phase: 'running', syncUrl: null })
	}, [])

	// Change to a different server URL.
	// This requires restarting the app to create a fresh Kora instance.
	const handleChangeServer = useCallback((newUrl: string | null) => {
		if (newUrl) {
			setSyncUrl(newUrl)
		} else {
			clearSyncUrl()
			markSetupComplete() // Still completed — just disconnected
		}
		// Reload to re-initialize Kora with the new URL.
		// This is cleaner than trying to hot-swap the sync connection,
		// and prevents data from one server context leaking to another.
		window.location.reload()
	}, [])

	const handleFactoryReset = useCallback(() => {
		factoryReset() // Clears all data and reloads
	}, [])

	if (state.phase === 'setup') {
		return <SetupScreen onConnect={handleConnect} onSkip={handleSkip} />
	}

	return (
		<ConnectedApp
			syncUrl={state.syncUrl}
			onChangeServer={handleChangeServer}
			onFactoryReset={handleFactoryReset}
		/>
	)
}

interface ConnectedAppProps {
	syncUrl: string | null
	onChangeServer: (newUrl: string | null) => void
	onFactoryReset: () => void
}

function ConnectedApp({ syncUrl, onChangeServer, onFactoryReset }: ConnectedAppProps) {
	const [authClient] = useState(() => createDesktopAuthClient(syncUrl))
	// Create the Kora app instance with optional sync.
	// This only runs once — the app instance is stable for the lifetime of this component.
	const [app] = useState(() =>
		createApp({
			schema,
			...(syncUrl
				? {
						sync: {
							url: syncUrl,
							authClient: createKoraAuthSync({ authClient, schema }),
						},
					}
				: {}),
			devtools: true,
		}),
	)

	// Connect to sync server once ready, and check for updates
	useEffect(() => {
		void completeOAuthCallbackFromLocation(authClient).catch((error) => {
			console.error('[Kora Auth] OAuth callback failed:', error)
		})
		if (syncUrl) {
			app.ready.then(() => app.sync?.connect())
		}
		checkForUpdates()
	}, [app, authClient, syncUrl])

	return (
		<AuthProvider
			client={authClient}
			fallback={
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						height: '100vh',
						background: '#0a0a0a',
						color: '#6b7280',
					}}
				>
					Restoring session...
				</div>
			}
		>
			<KoraProvider
				app={app}
				fallback={
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							height: '100vh',
							background: '#0a0a0a',
							color: '#6b7280',
						}}
					>
						Loading...
					</div>
				}
			>
				<App syncUrl={syncUrl} onChangeServer={onChangeServer} onFactoryReset={onFactoryReset} />
			</KoraProvider>
		</AuthProvider>
	)
}
