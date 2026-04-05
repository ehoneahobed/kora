import { createApp } from 'korajs'
import { KoraProvider } from '@korajs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import schema from './schema'
import { App } from './App'

const syncPort = import.meta.env.VITE_SYNC_PORT || '3001'

const app = createApp({
  schema,
  sync: {
    url: `ws://localhost:${syncPort}`,
  },
})

app.ready.then(() => app.sync?.connect())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KoraProvider app={app}>
      <App />
    </KoraProvider>
  </StrictMode>,
)
