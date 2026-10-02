/// <reference lib="webworker" />
/**
 * Web Worker script for running SQLite WASM in a dedicated worker.
 *
 * One worker serves one database. Requests from the owning (leader) tab arrive
 * by postMessage; requests from follower tabs arrive on the database's
 * BroadcastChannel once the leader sends `serve`. Both go through one
 * {@link TransactionSerializingWorkerBridge}, so transaction spans from different
 * tabs never interleave, and the leader tab's main thread is not on the
 * follower path at all.
 *
 * This script cannot be tested in Node.js; it is validated in browser suites.
 */

import { TransactionSerializingWorkerBridge, startWorkerRpcRelay } from '../multi-tab/tab-storage'
import type { WorkerRpcRelay } from '../multi-tab/tab-storage'
import type {
	WorkerEventMessage,
	WorkerInboundMessage,
	WorkerResponse,
} from './sqlite-wasm-channel'
import { createSqliteWasmCore } from './sqlite-wasm-worker-core'

declare const self: DedicatedWorkerGlobalScope

let relay: WorkerRpcRelay | null = null

const core = createSqliteWasmCore({
	postEvent: (event) => {
		const message: WorkerEventMessage = { id: -1, type: 'event', event }
		self.postMessage(message)
	},
	// Keep followers' watchdogs fed while a long statement blocks this worker.
	onProgress: () => relay?.beat(),
})

const serializer = new TransactionSerializingWorkerBridge({
	send: (request) => core.handle(request),
	terminate: () => {},
})

self.onmessage = (event: MessageEvent<WorkerInboundMessage>): void => {
	const { clientId, ...request } = event.data
	if (request.type === 'serve') {
		if (!relay) {
			relay = startWorkerRpcRelay(request.channelName, serializer)
		}
		const response: WorkerResponse = { id: request.id, type: 'success' }
		self.postMessage(response)
		return
	}
	void serializer.send(request, clientId).then(
		(response) => {
			if (request.type === 'close' || request.type === 'destroy') {
				// The pool is released; stop answering followers for this database.
				relay?.stop()
				relay = null
			}
			self.postMessage(response)
		},
		(error: unknown) => {
			const response: WorkerResponse = {
				id: request.id,
				type: 'error',
				message: error instanceof Error ? error.message : String(error),
				code: 'WORKER_ERROR',
			}
			self.postMessage(response)
		},
	)
}
