import { createApp } from 'korajs'
import { KoraProvider } from '@korajs/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import schema from './schema'
import { App } from './App'
import './index.css'
import koraWorkerUrl from './kora-worker.ts?worker&url'

const app = createApp({
  schema,
  store: {
    workerUrl: koraWorkerUrl,
  },
  devtools: true,
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KoraProvider app={app} fallback={<div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">Loading...</div>}>
      <App />
    </KoraProvider>
  </StrictMode>,
)
