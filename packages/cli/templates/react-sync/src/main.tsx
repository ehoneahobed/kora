import { createApp } from 'kora'
import { KoraProvider } from '@kora/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import schema from './schema'
import { App } from './App'

const app = createApp({
  schema,
  sync: {
    url: 'ws://localhost:3001/kora',
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KoraProvider app={app}>
      <App />
    </KoraProvider>
  </StrictMode>,
)
