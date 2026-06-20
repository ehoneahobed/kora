/// <reference lib="webworker" />
/**
 * SharedWorker host: one DedicatedWorker (SQLite WASM) per `dbName` per browser origin.
 *
 * Bundle this file separately and pass its URL as `store.sharedWorkerUrl` alongside `workerUrl`.
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

interface WorkerEntry {
	worker: Worker
	pending: Map<number, string>
}

declare const self: SharedWorkerGlobalScope

const pools = new Map<string, WorkerEntry>()

function getPool(dbName: string, workerUrl: string): WorkerEntry {
	const existing = pools.get(dbName)
	if (existing) {
		return existing
	}

	const worker = new Worker(workerUrl, { type: 'module' })
	const entry: WorkerEntry = { worker, pending: new Map() }

	worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
		const response = event.data
		const requestId = entry.pending.get(response.id)
		if (!requestId) {
			return
		}
		entry.pending.delete(response.id)
		const port = findPortForRequest(requestId)
		if (port) {
			const msg: SharedWorkerRpcResponse = {
				type: SW_RESPONSE,
				requestId,
				response,
			}
			port.postMessage(msg)
		}
	}

	pools.set(dbName, entry)
	return entry
}

const portRequestIds = new Map<MessagePort, Set<string>>()
const requestPort = new Map<string, MessagePort>()

function findPortForRequest(requestId: string): MessagePort | undefined {
	return requestPort.get(requestId)
}

self.onconnect = (event: MessageEvent): void => {
	const port = event.ports[0]
	if (!port) {
		return
	}

	port.start()
	portRequestIds.set(port, new Set())

	port.addEventListener('message', (messageEvent: MessageEvent<SharedWorkerRpcRequest>) => {
		const data = messageEvent.data
		if (data?.type !== SW_REQUEST) {
			return
		}

		const pool = getPool(data.dbName, data.workerUrl)
		pool.pending.set(data.request.id, data.requestId)
		requestPort.set(data.requestId, port)
		portRequestIds.get(port)?.add(data.requestId)

		pool.worker.postMessage(data.request)
	})

	port.addEventListener('messageerror', () => {
		const ids = portRequestIds.get(port)
		if (!ids) {
			return
		}
		for (const requestId of ids) {
			requestPort.delete(requestId)
		}
		portRequestIds.delete(port)
	})
}
