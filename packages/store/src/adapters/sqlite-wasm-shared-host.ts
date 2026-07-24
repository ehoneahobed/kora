/// <reference lib="webworker" />
/**
 * SharedWorker host: runs SQLite WASM directly inside the SharedWorker, one
 * database core per `dbName`, shared by every tab on the origin.
 *
 * A SharedWorker CANNOT spawn a nested `Worker` (the `Worker` constructor is not
 * defined in `SharedWorkerGlobalScope` in Chromium), so the host does not delegate
 * to a dedicated worker. It runs {@link createSqliteWasmCore} in its own scope.
 * Because each request is answered by a Promise from the core, responses are
 * correlated to their caller directly, with no inner-id bookkeeping.
 *
 * Bundle this file separately and pass its URL as `store.sharedWorkerUrl` alongside
 * `workerUrl`. The entry that bundles it must set `__KORA_SQLITE_WASM_URL` (via a
 * `?url` import of the sqlite wasm binary) the same way the dedicated worker entry
 * does, so the core can locate the hashed WASM asset in production builds.
 *
 * @example
 * ```typescript
 * createApp({
 *   store: {
 *     workerUrl: '/sqlite-wasm-worker.js',
 *     sharedWorkerUrl: '/sqlite-wasm-shared-host.js',
 *   },
 * })
 * ```
 */

import type { WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'
import { type SqliteWasmCore, createSqliteWasmCore } from './sqlite-wasm-worker-core'

const SW_REQUEST = 'kora-sw-request'
const SW_RESPONSE = 'kora-sw-response'

interface SharedWorkerRpcRequest {
	type: typeof SW_REQUEST
	requestId: string
	dbName: string
	workerUrl: string
	request: WorkerRequest
}

interface SharedWorkerRpcResponse {
	type: typeof SW_RESPONSE
	requestId: string
	response: WorkerResponse
}

/** Minimal structural view of a connected client `MessagePort`. */
export interface HostPort {
	start(): void
	postMessage(message: SharedWorkerRpcResponse): void
	addEventListener(
		type: 'message' | 'messageerror',
		handler: (event: { data: unknown }) => void,
	): void
}

export interface SharedWorkerHostOptions {
	/** Creates a database core. Injectable so the host routing can be unit-tested. */
	createCore: () => SqliteWasmCore
}

export interface SharedWorkerHost {
	/** Wire a newly connected client port into the host. */
	connect(port: HostPort): void
}

/**
 * Creates the SharedWorker host routing core: one SQLite core per `dbName`, shared
 * by every connected tab, with each request answered directly by the core.
 */
export function createSharedWorkerHost(options: SharedWorkerHostOptions): SharedWorkerHost {
	const cores = new Map<string, SqliteWasmCore>()

	function coreFor(dbName: string): SqliteWasmCore {
		let core = cores.get(dbName)
		if (!core) {
			core = options.createCore()
			cores.set(dbName, core)
		}
		return core
	}

	function connect(port: HostPort): void {
		port.start()

		port.addEventListener('message', (event: { data: unknown }): void => {
			const data = event.data as SharedWorkerRpcRequest | undefined
			if (data?.type !== SW_REQUEST) {
				return
			}

			const core = coreFor(data.dbName)
			void core.handle(data.request).then(
				(response) => {
					port.postMessage({ type: SW_RESPONSE, requestId: data.requestId, response })
				},
				(error: unknown) => {
					// The core catches its own errors, so this only fires on an unexpected
					// throw. Relay it so the client never hangs waiting for a response.
					const message = error instanceof Error ? error.message : 'SharedWorker core failed'
					port.postMessage({
						type: SW_RESPONSE,
						requestId: data.requestId,
						response: {
							id: data.request.id,
							type: 'error',
							message,
							code: 'SHARED_WORKER_CORE_ERROR',
						},
					})
				},
			)
		})
	}

	return { connect }
}

// Wire the host to the SharedWorker global only when running as an actual
// SharedWorker. The guard uses `instanceof SharedWorkerGlobalScope` so it is true
// in a real SharedWorker and false everywhere else (Node test runtimes, the main
// thread, a dedicated worker), which keeps `createSharedWorkerHost` unit-testable
// in isolation. A connection is delivered as a `connect` event whose `ports[0]` is
// the client MessagePort.
declare const self: SharedWorkerGlobalScope
if (
	typeof SharedWorkerGlobalScope !== 'undefined' &&
	typeof self !== 'undefined' &&
	self instanceof SharedWorkerGlobalScope
) {
	const host = createSharedWorkerHost({ createCore: createSqliteWasmCore })

	self.addEventListener('connect', (event: MessageEvent): void => {
		const port = event.ports[0]
		if (!port) {
			return
		}
		host.connect(port as unknown as HostPort)
	})
}
