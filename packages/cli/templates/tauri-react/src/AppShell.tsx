import { useState, useCallback, useEffect } from 'react'
import { createApp } from 'korajs'
import { KoraProvider } from '@korajs/react'
import schema from './schema'
import { App } from './App'
import { SetupScreen } from './SetupScreen'
import { getSyncUrl, setSyncUrl, clearSyncUrl, hasCompletedSetup, markSetupComplete, factoryReset } from './sync-config'
import { checkForUpdates } from './updater'

type AppState =
  | { phase: 'setup' }
  | { phase: 'running'; syncUrl: string | null }

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
  // Create the Kora app instance with optional sync.
  // This only runs once — the app instance is stable for the lifetime of this component.
  const [app] = useState(() =>
    createApp({
      schema,
      ...(syncUrl ? { sync: { url: syncUrl } } : {}),
      devtools: true,
    })
  )

  // Connect to sync server once ready, and check for updates
  useEffect(() => {
    if (syncUrl) {
      app.ready.then(() => app.sync?.connect())
    }
    checkForUpdates()
  }, [])

  return (
    <KoraProvider
      app={app}
      fallback={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#6b7280' }}>
          Loading...
        </div>
      }
    >
      <App
        syncUrl={syncUrl}
        onChangeServer={onChangeServer}
        onFactoryReset={onFactoryReset}
      />
    </KoraProvider>
  )
}
