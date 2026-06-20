import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../adapters/sqlite-wasm-channel'
import { SharedWorkerClientBridge } from './shared-worker-bridge'

type PortHandler = (event: { data: unknown }) => void

class MockMessagePort {
	static connected: MockMessagePort[] = []
	private readonly handlers = new Set<PortHandler>()

	start(): void {
		MockMessagePort.connected.push(this)
	}

	addEventListener(_type: 'message', handler: PortHandler): void {
		this.handlers.add(handler)
	}

	postMessage(data: unknown): void {
		const event = { data }
		for (const handler of this.handlers) {
			handler(event)
		}
	}

	close(): void {
		const index = MockMessagePort.connected.indexOf(this)
		if (index >= 0) {
			MockMessagePort.connected.splice(index, 1)
		}
	}
}

class MockSharedWorker {
	readonly port = new MockMessagePort()
}

describe('SharedWorkerClientBridge', () => {
	beforeEach(() => {
		MockMessagePort.connected = []
		vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
			'00000000-0000-4000-8000-000000000001',
		)
	})

	test('forwards worker requests through the shared worker port', async () => {
		const innerBridge = {
			send: vi.fn(
				async (request: WorkerRequest): Promise<WorkerResponse> => ({
					id: request.id,
					type: 'success',
					data: [{ id: 'row-1' }],
				}),
			),
			terminate: vi.fn(),
		}

		const hostPort = new MockMessagePort()
		hostPort.start()

		hostPort.addEventListener('message', (event: { data: unknown }) => {
			const data = event.data as {
				type: string
				request: WorkerRequest
				requestId: string
			}
			if (data?.type !== 'kora-sw-request') {
				return
			}
			void innerBridge.send(data.request).then((response) => {
				hostPort.postMessage({
					type: 'kora-sw-response',
					requestId: data.requestId,
					response,
				})
			})
		})

		const sw = { port: hostPort } as unknown as SharedWorker
		const bridge = new SharedWorkerClientBridge(sw, 'test-db', '/worker.js')

		const response = await bridge.send({ id: 3, type: 'query', sql: 'SELECT 1' })

		expect(response.type).toBe('success')
		expect(innerBridge.send).toHaveBeenCalledOnce()
		bridge.terminate()
	})
})
