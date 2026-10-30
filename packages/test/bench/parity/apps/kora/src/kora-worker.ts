// The SQLite WASM worker, exactly as the react-tailwind-sync template ships it: the WASM URL is
// imported so Vite resolves it with its content hash.
import sqliteWasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url'
;(globalThis as Record<string, unknown>).__KORA_SQLITE_WASM_URL = sqliteWasmUrl

import '@korajs/store/sqlite-wasm/worker'

// ── Observation (parity benchmark) ───────────────────────────────────────────────────────
// Times the WASM download and its compile in this worker and reports them to the page's probe
// over a BroadcastChannel (epoch milliseconds). Wrapping the two WebAssembly entry points only
// times them; arguments and results pass through unchanged. These run before the first open
// request, which is when the store loads SQLite.
const channel = new BroadcastChannel('kora-parity-probe')
const report = (name: string, at: number): void =>
	channel.postMessage({ name, at: performance.timeOrigin + at })

try {
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			if (entry instanceof PerformanceResourceTiming && entry.name.includes('.wasm')) {
				report('worker:wasm-fetch-start', entry.startTime)
				report('worker:wasm-fetched', entry.responseEnd)
			}
		}
	}).observe({ type: 'resource', buffered: true })
} catch {
	// Resource timing unavailable in this worker: the phases table says n/a.
}

const instantiateStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly)
WebAssembly.instantiateStreaming = async (source, imports) => {
	report('worker:wasm-instantiate-start', performance.now())
	const result = await instantiateStreaming(source, imports)
	report('worker:wasm-instantiated', performance.now())
	return result
}
const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (
	bytes: BufferSource,
	imports?: WebAssembly.Imports,
) => Promise<WebAssembly.WebAssemblyInstantiatedSource>
WebAssembly.instantiate = (async (bytes: BufferSource, imports?: WebAssembly.Imports) => {
	report('worker:wasm-instantiate-start', performance.now())
	const result = await instantiate(bytes, imports)
	report('worker:wasm-instantiated', performance.now())
	return result
}) as typeof WebAssembly.instantiate
