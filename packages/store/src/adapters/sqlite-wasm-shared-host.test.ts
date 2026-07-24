import { describe, expect, test } from 'vitest'
import type { WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'
import { type HostPort, createSharedWorkerHost } from './sqlite-wasm-shared-host'
import type { SqliteWasmCore } from './sqlite-wasm-worker-core'

const SW_REQUEST = 'kora-sw-request'

interface RpcResponse {
	type: string
	requestId: string
	response: WorkerResponse
}

/** A mock core that records requests and echoes a success carrying its db label. */
class MockCore implements SqliteWasmCore {
	readonly seen: WorkerRequest[] = []
	constructor(private readonly label: string) {}
	async handle(request: WorkerRequest): Promise<WorkerResponse> {
		this.seen.push(request)
		return { id: request.id, type: 'success', data: { db: this.label } }
	}
}

/** A core whose handle rejects, to exercise the host's error relay. */
class ThrowingCore implements SqliteWasmCore {
	handle(): Promise<WorkerResponse> {
		return Promise.reject(new Error('boom'))
	}
}

class MockHostPort implements HostPort {
	readonly received: RpcResponse[] = []
	private messageHandler: ((event: { data: unknown }) => void) | null = null

	start(): void {}

	addEventListener(
		type: 'message' | 'messageerror',
		handler: (event: { data: unknown }) => void,
	): void {
		if (type === 'message') {
			this.messageHandler = handler
		}
	}

	postMessage(message: RpcResponse): void {
		this.received.push(message)
	}

	send(requestId: string, dbName: string, request: WorkerRequest): void {
		this.messageHandler?.({
			data: { type: SW_REQUEST, requestId, dbName, workerUrl: '/worker.js', request },
		})
	}

	sendRaw(data: unknown): void {
		this.messageHandler?.({ data })
	}
}

function successDb(entry: RpcResponse | undefined): string {
	const response = entry?.response
	if (!response || response.type !== 'success') {
		throw new Error('expected a success response')
	}
	return (response.data as { db: string }).db
}

describe('createSharedWorkerHost', () => {
	test('routes each request to the core for its dbName and answers its caller', async () => {
		const cores: MockCore[] = []
		const host = createSharedWorkerHost({
			createCore: () => {
				const c = new MockCore(`core-${cores.length}`)
				cores.push(c)
				return c
			},
		})

		const portA = new MockHostPort()
		const portB = new MockHostPort()
		host.connect(portA)
		host.connect(portB)

		// Two tabs, same database: they must share ONE core, and each response goes
		// back to the tab that asked.
		portA.send('a1', 'app-db', { id: 0, type: 'query', sql: 'A' })
		portB.send('b1', 'app-db', { id: 0, type: 'query', sql: 'B' })
		// A different database gets its own core.
		portA.send('a2', 'other-db', { id: 0, type: 'query', sql: 'C' })

		await Promise.resolve()
		await Promise.resolve()

		expect(cores).toHaveLength(2) // one per dbName, not per tab
		expect(portA.received.map((r) => r.requestId).sort()).toEqual(['a1', 'a2'])
		expect(portB.received.map((r) => r.requestId)).toEqual(['b1'])
		// app-db responses come from the shared core-0; other-db from core-1.
		expect(successDb(portA.received.find((r) => r.requestId === 'a1'))).toBe('core-0')
		expect(successDb(portB.received[0])).toBe('core-0')
		expect(successDb(portA.received.find((r) => r.requestId === 'a2'))).toBe('core-1')
	})

	test('relays a core failure to the caller instead of hanging', async () => {
		const host = createSharedWorkerHost({ createCore: () => new ThrowingCore() })
		const port = new MockHostPort()
		host.connect(port)

		port.send('r', 'db', { id: 0, type: 'open', ddlStatements: [] })
		await Promise.resolve()
		await Promise.resolve()

		expect(port.received).toHaveLength(1)
		expect(port.received[0]?.response.type).toBe('error')
		if (port.received[0]?.response.type === 'error') {
			expect(port.received[0].response.code).toBe('SHARED_WORKER_CORE_ERROR')
		}
	})

	test('ignores non-RPC messages', async () => {
		let created = 0
		const host = createSharedWorkerHost({
			createCore: () => {
				created += 1
				return new MockCore('x')
			},
		})
		const port = new MockHostPort()
		host.connect(port)

		port.sendRaw({ type: 'something-else' })
		port.sendRaw(null)
		port.sendRaw('a string')
		await Promise.resolve()
		expect(created).toBe(0)

		port.send('real', 'db', { id: 0, type: 'query', sql: 'x' })
		await Promise.resolve()
		expect(created).toBe(1)
	})
})
