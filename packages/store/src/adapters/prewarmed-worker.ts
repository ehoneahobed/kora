/**
 * A SQLite WASM worker started before the store asked for one. `createApp` starts it as soon as
 * the app begins loading its runtime (the worker loads SQLite meanwhile, touching no storage),
 * and the adapter takes it instead of creating its own when this tab leads the database. Shared
 * through a global so the app shell needs no store code: the registry is a Map from the worker's
 * absolute URL to the Worker.
 */
export const PREWARMED_WORKERS_KEY = Symbol.for('kora.prewarmedSqliteWorkers')

function registry(): Map<string, Worker> | undefined {
	return (globalThis as Record<symbol, Map<string, Worker> | undefined>)[PREWARMED_WORKERS_KEY]
}

function keyOf(workerUrl: string | URL): string {
	try {
		return new URL(String(workerUrl), globalThis.location?.href).href
	} catch {
		return String(workerUrl)
	}
}

/** The worker started for `workerUrl`, if one is waiting (it is no longer waiting after). */
export function takePrewarmedWorker(workerUrl: string | URL): Worker | null {
	const workers = registry()
	const key = keyOf(workerUrl)
	const worker = workers?.get(key) ?? null
	if (worker) workers?.delete(key)
	return worker
}

/** Stop a worker started for `workerUrl` that this tab will not use (a follower, a refused build). */
export function discardPrewarmedWorker(workerUrl: string | URL): void {
	takePrewarmedWorker(workerUrl)?.terminate()
}
