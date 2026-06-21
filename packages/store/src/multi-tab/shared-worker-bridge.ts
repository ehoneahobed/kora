/// <reference lib="dom" />
import type { WorkerBridge, WorkerRequest, WorkerResponse } from '../adapters/sqlite-wasm-channel'
import { WorkerTimeoutError } from '../errors'

const SW_REQUEST = 'kora-sw-request'
const SW_RESPONSE = 'kora-sw-response'

export interface SharedWorkerRpcRequest {
	type: typeof SW_REQUEST
	requestId: string
	dbName: string
	workerUrl: string
	request: WorkerRequest
}

export interface SharedWorkerRpcResponse {
	type: typeof SW_RESPONSE
	requestId: string
	response: WorkerResponse
}

/**
 * Forwards {@link WorkerBridge} RPC to a SharedWorker that hosts one DedicatedWorker per `dbName`.
 * Pair with the bundled `sqlite-wasm-shared-host` worker script.
 */
export class SharedWorkerClientBridge implements WorkerBridge {
	private readonly port: MessagePort
	private readonly pending = new Map<
		string,
		{ resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }
	>()
	private readonly timeoutMs: number
	private terminated = false

	constructor(
		sharedWorker: SharedWorker,
		private readonly dbName: string,
		private readonly workerUrl: string,
		timeoutMs = 30000,
	) {
		this.timeoutMs = timeoutMs
		this.port = sharedWorker.port
		this.port.start()
		this.port.addEventListener('message', (event: MessageEvent<SharedWorkerRpcResponse>) => {
			const data = event.data
			if (data?.type !== SW_RESPONSE) {
				return
			}
			const entry = this.pending.get(data.requestId)
			if (entry) {
				this.pending.delete(data.requestId)
				entry.resolve(data.response)
			}
		})
	}

	async send(request: WorkerRequest): Promise<WorkerResponse> {
		if (this.terminated) {
			return {
				id: request.id,
				type: 'error',
				message: 'SharedWorker bridge terminated',
				code: 'BRIDGE_TERMINATED',
			}
		}

		const requestId = crypto.randomUUID()
		const msg: SharedWorkerRpcRequest = {
			type: SW_REQUEST,
			requestId,
			dbName: this.dbName,
			workerUrl: this.workerUrl,
			request,
		}

		return new Promise<WorkerResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId)
				reject(new WorkerTimeoutError(`shared-worker:${request.type}`, this.timeoutMs))
			}, this.timeoutMs)

			this.pending.set(requestId, {
				resolve: (response) => {
					clearTimeout(timer)
					resolve(response)
				},
				reject: (error) => {
					clearTimeout(timer)
					reject(error)
				},
			})

			this.port.postMessage(msg)
		})
	}

	terminate(): void {
		if (this.terminated) {
			return
		}
		this.terminated = true
		this.port.close()
		for (const [, entry] of this.pending) {
			entry.reject(new Error('SharedWorker bridge terminated'))
		}
		this.pending.clear()
	}
}
