import { KoraProvider } from '@korajs/react'
import { createApp } from 'korajs'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import koraWorkerUrl from './kora-worker.ts?worker&url'
import schema from './schema'

const syncPort = import.meta.env.VITE_SYNC_PORT || '3001'
const localOnly = import.meta.env.VITE_E2E_LOCAL === 'true'
const dbFromUrl = new URLSearchParams(window.location.search).get('db')
const dbName = dbFromUrl ?? (localOnly ? 'kora-e2e-local' : 'kora-e2e-sync')

const app = createApp({
	schema,
	store: {
		workerUrl: koraWorkerUrl,
		workerResponseTimeoutMs: 90_000,
		name: dbName,
	},
	...(localOnly
		? {}
		: {
				sync: {
					url: `ws://localhost:${syncPort}`,
				},
			}),
})

void app.ready.then(() => {
	window.__KORA_E2E_READY__ = true
})

if (!localOnly) {
	app.ready.then(() => app.sync?.connect())
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<KoraProvider app={app} fallback={<div data-testid="loading">Loading…</div>}>
			<App />
		</KoraProvider>
	</StrictMode>,
)
