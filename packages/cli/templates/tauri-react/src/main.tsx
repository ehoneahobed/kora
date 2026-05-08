import { createApp } from 'korajs'
import { KoraProvider } from '@korajs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import schema from './schema'
import { App } from './App'

// Tauri apps use native SQLite — no WASM, no web workers, no OPFS.
// The Tauri adapter is auto-detected via __TAURI_INTERNALS__.
const app = createApp({
  schema,
  // Sync is optional — uncomment to connect to a remote sync server:
  // sync: {
  //   url: 'ws://localhost:3001/kora-sync',
  // },
  devtools: true,
})

app.ready.then(() => {
  // If sync is configured, connect after the store is ready:
  // app.sync?.connect()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KoraProvider
      app={app}
      fallback={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#6b7280' }}>
          Loading...
        </div>
      }
    >
      <App />
    </KoraProvider>
  </StrictMode>,
)
