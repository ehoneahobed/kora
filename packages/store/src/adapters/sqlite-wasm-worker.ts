/// <reference lib="webworker" />
/**
 * Web Worker script for running SQLite WASM in a dedicated worker.
 *
 * This file is intended to run inside a Web Worker in browsers. It wires one
 * {@link createSqliteWasmCore} to the worker's message channel.
 *
 * This script cannot be tested in Node.js; it is validated in E2E browser tests.
 */

import type { WorkerRequest } from './sqlite-wasm-channel'
import { createSqliteWasmCore } from './sqlite-wasm-worker-core'

declare const self: DedicatedWorkerGlobalScope

const core = createSqliteWasmCore()

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
	void core.handle(event.data).then((response) => {
		self.postMessage(response)
	})
}
