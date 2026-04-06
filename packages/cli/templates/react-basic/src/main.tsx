import { createApp } from 'korajs'
import { KoraProvider } from '@korajs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import schema from './schema'
import { App } from './App'
import './index.css'

const app = createApp({
  schema,
  store: {
    workerUrl: new URL('./kora-worker.ts', import.meta.url),
  },
  devtools: true,
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KoraProvider app={app} fallback={<div>Loading...</div>}>
      <App />
    </KoraProvider>
  </StrictMode>,
)
