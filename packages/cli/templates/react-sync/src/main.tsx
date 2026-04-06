import { createApp } from 'korajs'
import { KoraProvider } from '@korajs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import schema from './schema'
import { App } from './App'
import './index.css'
import koraWorkerUrl from './kora-worker.ts?worker&url'

// Build sync URL: use env var if set, otherwise derive from current page host.
// This allows the Vite proxy (/kora-sync → ws://localhost:3001) to work in dev,
// and also works through any tunnel (ngrok, cloudflared) without extra configuration.
const syncUrl = import.meta.env.VITE_SYNC_URL
  || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/kora-sync`

const app = createApp({
  schema,
  sync: {
    url: syncUrl,
  },
  store: {
    workerUrl: koraWorkerUrl,
  },
  devtools: true,
})

// Connect to sync server once the app is ready
app.ready.then(() => app.sync?.connect())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KoraProvider app={app} fallback={<div>Loading...</div>}>
      <App />
    </KoraProvider>
  </StrictMode>,
)
