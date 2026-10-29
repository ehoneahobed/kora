import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkerRequest, WorkerResponse } from '../adapters/sqlite-wasm-channel'
import {
	FollowerBroadcastBridge,
	TransactionSerializingWorkerBridge,
	serveSnapshotBarriers,
	startLeaderRpcRelay,
} from './tab-storage'

type ChannelHandler = (event: { data: unknown }) => void

class MockBroadcastChannel {
	static channels = new Map<string, Set<MockBroadcastChannel>>()
	private readonly handlers = new Set<ChannelHandler>()

	constructor(public readonly name: string) {
		const set = MockBroadcastChannel.channels.get(name) ?? new Set()
		set.add(this)
		MockBroadcastChannel.channels.set(name, set)
	}

	postMessage(data: unknown): void {
		const set = MockBroadcastChannel.channels.get(this.name) ?? new Set()
		for (const peer of set) {
			if (peer !== this) {
				for (const handler of peer.handlers) {
					handler({ data })
				}
			}
		}
	}

	addEventListener(_type: 'message', handler: ChannelHandler): void {
		this.handlers.add(handler)
	}

	removeEventListener(_type: 'message', handler: ChannelHandler): void {
		this.handlers.delete(handler)
	}

	close(): void {
		const set = MockBroadcastChannel.channels.get(this.name)
		set?.delete(this)
	}
}

describe('multi-tab tab storage RPC', () => {
	beforeEach(() => {
		MockBroadcastChannel.channels.clear()
		vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
		let id = 0
		vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
			id += 1
			return `00000000-0000-4000-8000-${id.toString().padStart(12, '0')}`
		})
	})

	test('follower forwards worker requests to leader bridge', async () => {
		const channelName = 'kora-storage-test-db'
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

		const stop = startLeaderRpcRelay(channelName, innerBridge)
		const follower = new FollowerBroadcastBridge(channelName, 5000)

		const response = await follower.send({ id: 7, type: 'query', sql: 'SELECT 1' })

		expect(response.type).toBe('success')
		expect(innerBridge.send).toHaveBeenCalledOnce()

		follower.terminate()
		stop()
	})

	test('waitForLeader resolves true when a leader relay is answering', async () => {
		const channelName = 'kora-storage-ready-db'
		const innerBridge = {
			send: vi.fn(
				async (r: WorkerRequest): Promise<WorkerResponse> => ({ id: r.id, type: 'success' }),
			),
			terminate: vi.fn(),
		}
		const stop = startLeaderRpcRelay(channelName, innerBridge)
		const follower = new FollowerBroadcastBridge(channelName, 5000)

		await expect(follower.waitForLeader(300, 3)).resolves.toBe(true)

		follower.terminate()
		stop()
	})

	test('waitForLeader resolves false when no leader is present', async () => {
		const follower = new FollowerBroadcastBridge('kora-storage-empty-db', 5000)

		await expect(follower.waitForLeader(120, 2)).resolves.toBe(false)

		follower.terminate()
	})

	test('send fails fast with NoLeaderError when the leader is gone', async () => {
		const channelName = 'kora-storage-dead-db'
		const innerBridge = {
			send: vi.fn(
				async (r: WorkerRequest): Promise<WorkerResponse> => ({ id: r.id, type: 'success' }),
			),
			terminate: vi.fn(),
		}
		const stop = startLeaderRpcRelay(channelName, innerBridge)
		// Leader disappears before the follower sends (tab closed / crashed).
		stop()

		// Long hard timeout, short liveness probe: the probe must trip first and reject
		// fast rather than waiting out the 30s ceiling.
		const follower = new FollowerBroadcastBridge(channelName, 30000, 60)

		await expect(follower.send({ id: 1, type: 'query', sql: 'SELECT 1' })).rejects.toMatchObject({
			code: 'NO_LEADER',
		})

		follower.terminate()
	})

	test('a follower that has not heard the leader recently pings it at once (LMS-7)', async () => {
		const channelName = `kora-storage-ping-at-once-${Date.now()}`
		const leaderSide = new BroadcastChannel(channelName)
		const pings: number[] = []
		leaderSide.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
			if (event.data?.type === 'kora-leader-ping') pings.push(Date.now())
		})
		// A long watchdog interval: only a ping sent when the watchdog starts can arrive
		// within the wait below. Before the fix the first ping waited a full interval, and
		// timer jitter could skip it, so a live leader was declared absent unasked.
		const follower = new FollowerBroadcastBridge(channelName, 60_000, 10_000)
		const pending = follower.send({ id: 1, type: 'query', sql: 'SELECT 1' }).catch(() => {})

		await vi.waitFor(() => expect(pings.length).toBeGreaterThanOrEqual(1), { timeout: 2000 })

		follower.terminate()
		await pending
		leaderSide.close()
	})

	test('serializes whole transaction spans across bridge clients', async () => {
		const calls: string[] = []
		const innerBridge = {
			send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
				calls.push(request.type)
				return { id: request.id, type: 'success' }
			}),
			terminate: vi.fn(),
		}
		const bridge = new TransactionSerializingWorkerBridge(innerBridge)

		await bridge.send({ id: 1, type: 'begin' }, 'leader')
		const followerBegin = bridge.send({ id: 2, type: 'begin' }, 'follower')
		const leaderExecute = bridge.send(
			{ id: 3, type: 'execute', sql: 'INSERT INTO todos VALUES (?)' },
			'leader',
		)

		await leaderExecute
		expect(calls).toEqual(['begin', 'execute'])

		await bridge.send({ id: 4, type: 'commit' }, 'leader')
		await followerBegin

		expect(calls).toEqual(['begin', 'execute', 'commit', 'begin'])
		bridge.terminate()
	})

	test('rolls back and resumes when a transaction client disappears', async () => {
		vi.useFakeTimers()
		const calls: string[] = []
		const innerBridge = {
			send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
				calls.push(request.type)
				return { id: request.id, type: 'success' }
			}),
			terminate: vi.fn(),
		}
		const bridge = new TransactionSerializingWorkerBridge(innerBridge, 50)

		await bridge.send({ id: 1, type: 'begin' }, 'follower')
		const leaderQuery = bridge.send({ id: 2, type: 'query', sql: 'SELECT 1' }, 'leader')

		await vi.advanceTimersByTimeAsync(60)

		await expect(leaderQuery).resolves.toMatchObject({ type: 'success' })
		expect(calls).toEqual(['begin', 'rollback', 'query'])

		await expect(
			bridge.send({ id: 3, type: 'execute', sql: 'INSERT INTO todos VALUES (?)' }, 'follower'),
		).resolves.toMatchObject({
			type: 'error',
			code: 'TRANSACTION_ABORTED',
		})

		await expect(bridge.send({ id: 4, type: 'begin' }, 'follower')).resolves.toMatchObject({
			type: 'success',
		})
		await bridge.send({ id: 5, type: 'rollback' }, 'follower')
		bridge.terminate()
		vi.useRealTimers()
	})

	test('keeps a failed transaction span until its owner rolls back', async () => {
		const calls: string[] = []
		const innerBridge = {
			send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
				calls.push(request.type === 'execute' ? `execute:${request.sql}` : request.type)
				if (request.type === 'execute' && request.sql === 'BAD') {
					return { id: request.id, type: 'error', message: 'no such table', code: 'EXEC_ERROR' }
				}
				if (request.type === 'commit') {
					return { id: request.id, type: 'error', message: 'FOREIGN KEY', code: 'EXEC_ERROR' }
				}
				return { id: request.id, type: 'success' }
			}),
			terminate: vi.fn(),
		}
		const bridge = new TransactionSerializingWorkerBridge(innerBridge)

		await bridge.send({ id: 1, type: 'begin' }, 'follower')
		await expect(
			bridge.send({ id: 2, type: 'execute', sql: 'BAD' }, 'follower'),
		).resolves.toMatchObject({ type: 'error' })
		const other = bridge.send({ id: 3, type: 'execute', sql: 'OTHER' }, 'leader')
		await expect(bridge.send({ id: 4, type: 'commit' }, 'follower')).resolves.toMatchObject({
			type: 'error',
		})
		await Promise.resolve()
		// Neither the statement error nor the failed COMMIT released the span.
		expect(calls).toEqual(['begin', 'execute:BAD', 'commit'])
		await bridge.send({ id: 5, type: 'rollback' }, 'follower')
		await other
		expect(calls).toEqual(['begin', 'execute:BAD', 'commit', 'rollback', 'execute:OTHER'])
		bridge.terminate()
	})

	test('rolls a span back itself before serving another client when a request throws', async () => {
		const calls: string[] = []
		const innerBridge = {
			send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
				calls.push(request.type === 'execute' ? `execute:${request.sql}` : request.type)
				if (request.type === 'execute' && request.sql === 'THROW') {
					throw new Error('worker error')
				}
				return { id: request.id, type: 'success' }
			}),
			terminate: vi.fn(),
		}
		const bridge = new TransactionSerializingWorkerBridge(innerBridge)

		await bridge.send({ id: 1, type: 'begin' }, 'follower')
		const other = bridge.send({ id: 2, type: 'execute', sql: 'OTHER' }, 'leader')
		await expect(bridge.send({ id: 3, type: 'execute', sql: 'THROW' }, 'follower')).rejects.toThrow(
			'worker error',
		)
		await other
		expect(calls).toEqual(['begin', 'execute:THROW', 'rollback', 'execute:OTHER'])
		// The owner's later span statements are refused, never run in autocommit.
		await expect(
			bridge.send({ id: 4, type: 'execute', sql: 'LATE' }, 'follower'),
		).resolves.toMatchObject({ type: 'error', code: 'TRANSACTION_ABORTED' })
		expect(calls).not.toContain('execute:LATE')
		// Its ROLLBACK ends the abort without running (another client may own a span by
		// then), and its later autocommit writes run again.
		await bridge.send({ id: 5, type: 'begin' }, 'leader')
		await expect(bridge.send({ id: 6, type: 'rollback' }, 'follower')).resolves.toMatchObject({
			type: 'success',
		})
		await bridge.send({ id: 7, type: 'commit' }, 'leader')
		await bridge.send({ id: 8, type: 'execute', sql: 'AFTER' }, 'follower')
		expect(calls.slice(4)).toEqual(['begin', 'commit', 'execute:AFTER'])
		bridge.terminate()
	})

	test('stops serving when its own rollback of an aborted span fails', async () => {
		const calls: string[] = []
		const innerBridge = {
			send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
				calls.push(request.type === 'execute' ? `execute:${request.sql}` : request.type)
				if (request.type === 'execute' && request.sql === 'THROW') throw new Error('worker error')
				if (request.type === 'rollback') throw new Error('worker timeout')
				return { id: request.id, type: 'success' }
			}),
			terminate: vi.fn(),
		}
		const onBroken = vi.fn()
		const bridge = new TransactionSerializingWorkerBridge(innerBridge, 10_000, { onBroken })

		await bridge.send({ id: 1, type: 'begin' }, 'follower')
		const other = bridge.send({ id: 2, type: 'execute', sql: 'OTHER' }, 'leader')
		await expect(bridge.send({ id: 3, type: 'execute', sql: 'THROW' }, 'follower')).rejects.toThrow(
			'worker error',
		)
		// The transaction may still be open in the worker: the queued write never runs
		// there and fails retriably instead of being acknowledged and later lost.
		await expect(other).rejects.toMatchObject({
			code: 'BRIDGE_TERMINATED',
			context: { retriable: true },
		})
		await expect(
			bridge.send({ id: 4, type: 'execute', sql: 'LATER' }, 'leader'),
		).rejects.toMatchObject({ code: 'BRIDGE_TERMINATED' })
		expect(calls).toEqual(['begin', 'execute:THROW', 'rollback'])
		expect(innerBridge.terminate).toHaveBeenCalledTimes(1)
		expect(onBroken).toHaveBeenCalledTimes(1)
	})

	test('stops serving when the idle reclaim rollback answers an unexpected error', async () => {
		vi.useFakeTimers()
		try {
			const calls: string[] = []
			const innerBridge = {
				send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
					calls.push(request.type)
					if (request.type === 'rollback') {
						return { id: request.id, type: 'error', message: 'disk I/O error', code: 'EXEC_ERROR' }
					}
					return { id: request.id, type: 'success' }
				}),
				terminate: vi.fn(),
			}
			const onBroken = vi.fn()
			const bridge = new TransactionSerializingWorkerBridge(innerBridge, 50, { onBroken })

			await bridge.send({ id: 1, type: 'begin' }, 'follower')
			const other = bridge.send({ id: 2, type: 'query', sql: 'SELECT 1' }, 'leader')
			const settled = expect(other).rejects.toMatchObject({ code: 'BRIDGE_TERMINATED' })
			await vi.advanceTimersByTimeAsync(60)
			await settled
			expect(calls).toEqual(['begin', 'rollback'])
			expect(onBroken).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	test("stops serving when the owner's own rollback answers an unexpected error", async () => {
		const calls: string[] = []
		const innerBridge = {
			send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
				calls.push(request.type === 'execute' ? `execute:${request.sql}` : request.type)
				if (request.type === 'execute' && request.sql === 'BAD') {
					return { id: request.id, type: 'error', message: 'constraint failed', code: 'EXEC_ERROR' }
				}
				if (request.type === 'rollback') {
					return { id: request.id, type: 'error', message: 'disk I/O error', code: 'EXEC_ERROR' }
				}
				return { id: request.id, type: 'success' }
			}),
			terminate: vi.fn(),
		}
		const onBroken = vi.fn()
		const bridge = new TransactionSerializingWorkerBridge(innerBridge, 10_000, { onBroken })

		await bridge.send({ id: 1, type: 'begin' }, 'follower')
		await bridge.send({ id: 2, type: 'execute', sql: 'BAD' }, 'follower')
		const other = bridge.send({ id: 3, type: 'execute', sql: 'OTHER' }, 'leader')
		const settled = expect(other).rejects.toMatchObject({
			code: 'BRIDGE_TERMINATED',
			context: { retriable: true },
		})
		await expect(bridge.send({ id: 4, type: 'rollback' }, 'follower')).resolves.toMatchObject({
			type: 'error',
		})
		// The transaction may still be open: the queued write never runs inside it.
		await settled
		await expect(
			bridge.send({ id: 5, type: 'execute', sql: 'LATER' }, 'leader'),
		).rejects.toMatchObject({ code: 'BRIDGE_TERMINATED' })
		expect(calls).toEqual(['begin', 'execute:BAD', 'rollback'])
		expect(innerBridge.terminate).toHaveBeenCalledTimes(1)
		expect(onBroken).toHaveBeenCalledTimes(1)
	})

	test("releases the span when the owner's rollback finds no transaction active", async () => {
		const calls: string[] = []
		const innerBridge = {
			send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
				calls.push(request.type === 'execute' ? `execute:${request.sql}` : request.type)
				if (request.type === 'rollback') {
					return {
						id: request.id,
						type: 'error',
						message: 'cannot rollback - no transaction is active',
						code: 'EXEC_ERROR',
					}
				}
				return { id: request.id, type: 'success' }
			}),
			terminate: vi.fn(),
		}
		const onBroken = vi.fn()
		const bridge = new TransactionSerializingWorkerBridge(innerBridge, 10_000, { onBroken })

		await bridge.send({ id: 1, type: 'begin' }, 'follower')
		const other = bridge.send({ id: 2, type: 'execute', sql: 'OTHER' }, 'leader')
		await bridge.send({ id: 3, type: 'rollback' }, 'follower')
		await expect(other).resolves.toMatchObject({ type: 'success' })
		expect(calls).toEqual(['begin', 'rollback', 'execute:OTHER'])
		expect(onBroken).not.toHaveBeenCalled()
		bridge.terminate()
	})

	test('keeps serving when its rollback finds no transaction active', async () => {
		const calls: string[] = []
		const innerBridge = {
			send: vi.fn(async (request: WorkerRequest): Promise<WorkerResponse> => {
				calls.push(request.type === 'execute' ? `execute:${request.sql}` : request.type)
				if (request.type === 'execute' && request.sql === 'THROW') throw new Error('worker error')
				if (request.type === 'rollback') {
					return {
						id: request.id,
						type: 'error',
						message: 'cannot rollback - no transaction is active',
						code: 'EXEC_ERROR',
					}
				}
				return { id: request.id, type: 'success' }
			}),
			terminate: vi.fn(),
		}
		const bridge = new TransactionSerializingWorkerBridge(innerBridge)
		await bridge.send({ id: 1, type: 'begin' }, 'follower')
		const other = bridge.send({ id: 2, type: 'execute', sql: 'OTHER' }, 'leader')
		await expect(
			bridge.send({ id: 3, type: 'execute', sql: 'THROW' }, 'follower'),
		).rejects.toThrow()
		await expect(other).resolves.toMatchObject({ type: 'success' })
		expect(innerBridge.terminate).not.toHaveBeenCalled()
		bridge.terminate()
	})

	describe('snapshot barrier requests', () => {
		test('are answered by the leader tab and never reach the worker bridge', async () => {
			const channelName = 'kora-storage-barrier-db'
			const worker = { send: vi.fn(), terminate: vi.fn() }
			const stopRelay = startLeaderRpcRelay(channelName, worker)
			const run = vi.fn(async () => {})
			const stopServing = serveSnapshotBarriers(channelName, run)
			const follower = new FollowerBroadcastBridge(channelName, 5000)

			await expect(follower.requestSnapshotBarrier()).resolves.toMatchObject({ type: 'success' })
			expect(run).toHaveBeenCalledOnce()
			expect(worker.send).not.toHaveBeenCalled()

			follower.terminate()
			stopServing()
			stopRelay()
		})

		test("carry the leader's failure (code, message, quota) back to the follower", async () => {
			const channelName = 'kora-storage-barrier-fail-db'
			const stopServing = serveSnapshotBarriers(channelName, async () => {
				throw new DOMException('storage is full', 'QuotaExceededError')
			})
			const follower = new FollowerBroadcastBridge(channelName, 5000)

			await expect(follower.requestSnapshotBarrier()).resolves.toMatchObject({
				type: 'error',
				message: 'storage is full',
				context: { quotaExceeded: true },
			})

			follower.terminate()
			stopServing()
		})

		test('fail with a retriable LeaderUnresponsiveError when the leader goes silent', async () => {
			vi.useFakeTimers()
			const channelName = 'kora-storage-barrier-hung-db'
			const stopRelay = startLeaderRpcRelay(
				channelName,
				{ send: vi.fn(), terminate: vi.fn() },
				{ heartbeatMs: 20 },
			)
			const stopServing = serveSnapshotBarriers(channelName, () => new Promise<void>(() => {}))
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			const settled = follower.requestSnapshotBarrier().catch((error: unknown) => error)
			await vi.advanceTimersByTimeAsync(60)
			stopRelay()
			stopServing()
			await vi.advanceTimersByTimeAsync(100)
			await expect(settled).resolves.toMatchObject({ code: 'LEADER_UNRESPONSIVE' })
			follower.terminate()
			vi.useRealTimers()
		})

		test('fail at once when another leader worker starts beating (the request died with the old one)', async () => {
			vi.useFakeTimers()
			const channelName = 'kora-storage-barrier-replaced-db'
			const bridge = { send: vi.fn(), terminate: vi.fn() }
			const stopOld = startLeaderRpcRelay(channelName, bridge, { heartbeatMs: 20 })
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			await vi.advanceTimersByTimeAsync(20)
			const settled = follower.requestSnapshotBarrier().catch((error: unknown) => error)
			stopOld()
			const stopNew = startLeaderRpcRelay(channelName, bridge, { heartbeatMs: 20 })
			await expect(settled).resolves.toMatchObject({ code: 'BRIDGE_TERMINATED' })
			follower.terminate()
			stopNew()
			vi.useRealTimers()
		})

		test('are rejected with BRIDGE_TERMINATED when the follower bridge is terminated', async () => {
			const channelName = 'kora-storage-barrier-terminate-db'
			const stopServing = serveSnapshotBarriers(channelName, () => new Promise<void>(() => {}))
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			const pending = follower.requestSnapshotBarrier()
			follower.terminate()
			await expect(pending).rejects.toMatchObject({ code: 'BRIDGE_TERMINATED' })
			await expect(follower.requestSnapshotBarrier()).rejects.toMatchObject({
				code: 'BRIDGE_TERMINATED',
			})
			stopServing()
		})
	})

	describe('hung-leader detection and request ids (NEW-STORE-9)', () => {
		function slowBridge(): {
			bridge: { send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
			finish: () => void
		} {
			let finish: () => void = () => {}
			const bridge = {
				send: vi.fn(
					(request: WorkerRequest): Promise<WorkerResponse> =>
						new Promise((resolve) => {
							finish = () => resolve({ id: request.id, type: 'success' })
						}),
				),
				terminate: vi.fn(),
			}
			return { bridge, finish: () => finish() }
		}

		test('a leader that keeps sending heartbeats is waited for, however long the request', async () => {
			vi.useFakeTimers()
			const channelName = 'kora-storage-busy-db'
			const { bridge, finish } = slowBridge()
			const stop = startLeaderRpcRelay(channelName, bridge, { heartbeatMs: 20 })
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			const pending = follower.send({ id: 1, type: 'query', sql: 'SELECT 1' })
			await vi.advanceTimersByTimeAsync(1000)
			finish()
			await expect(pending).resolves.toMatchObject({ type: 'success' })
			follower.terminate()
			stop()
			vi.useRealTimers()
		})

		test('a leader that goes silent fails pending requests with a retriable LeaderUnresponsiveError', async () => {
			vi.useFakeTimers()
			const channelName = 'kora-storage-hung-db'
			const { bridge } = slowBridge()
			const stop = startLeaderRpcRelay(channelName, bridge, { heartbeatMs: 20 })
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			const pending = follower.send({ id: 1, type: 'execute', sql: 'INSERT', requestId: 'r-1' })
			const settled = pending.catch((error: unknown) => error)
			await vi.advanceTimersByTimeAsync(60)
			// The leader hangs: no heartbeats, no pongs, no response.
			stop()
			await vi.advanceTimersByTimeAsync(100)
			await expect(settled).resolves.toMatchObject({
				name: 'LeaderUnresponsiveError',
				code: 'LEADER_UNRESPONSIVE',
				context: expect.objectContaining({ requestId: 'r-1', retriable: true }),
			})
			follower.terminate()
			vi.useRealTimers()
		})

		test('the leader answers a retried request id from its cache instead of applying it twice', async () => {
			const channelName = 'kora-storage-dedup-db'
			const bridge = {
				send: vi.fn(
					async (r: WorkerRequest): Promise<WorkerResponse> => ({ id: r.id, type: 'success' }),
				),
				terminate: vi.fn(),
			}
			const stop = startLeaderRpcRelay(channelName, bridge)
			const follower = new FollowerBroadcastBridge(channelName, 5000)
			const request: WorkerRequest = { id: 1, type: 'execute', sql: 'INSERT', requestId: 'same' }
			await follower.send(request)
			await follower.send(request)
			expect(bridge.send).toHaveBeenCalledOnce()
			follower.terminate()
			stop()
		})

		test('an AbortSignal cancels the wait with RequestAbortedError', async () => {
			const channelName = 'kora-storage-abort-db'
			const { bridge } = slowBridge()
			const stop = startLeaderRpcRelay(channelName, bridge, { heartbeatMs: 20 })
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			const controller = new AbortController()
			const pending = follower.send({ id: 1, type: 'query', sql: 'SELECT 1' }, undefined, {
				signal: controller.signal,
			})
			controller.abort()
			await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
			follower.terminate()
			stop()
		})

		test('terminating a follower bridge rejects pending requests with a retriable error', async () => {
			const channelName = 'kora-storage-terminate-db'
			const { bridge } = slowBridge()
			const stop = startLeaderRpcRelay(channelName, bridge, { heartbeatMs: 20 })
			const follower = new FollowerBroadcastBridge(channelName, 5000, 20)
			const pending = follower.send({ id: 1, type: 'query', sql: 'SELECT 1' })
			follower.terminate()
			await expect(pending).rejects.toMatchObject({
				code: 'BRIDGE_TERMINATED',
				context: expect.objectContaining({ retriable: true }),
			})
			stop()
		})

		test('a follower cannot close or destroy the leader database', async () => {
			const channelName = 'kora-storage-close-db'
			const bridge = {
				send: vi.fn(
					async (r: WorkerRequest): Promise<WorkerResponse> => ({ id: r.id, type: 'success' }),
				),
				terminate: vi.fn(),
			}
			const stop = startLeaderRpcRelay(channelName, bridge)
			const follower = new FollowerBroadcastBridge(channelName, 5000)
			await expect(follower.send({ id: 1, type: 'close' })).resolves.toMatchObject({
				type: 'success',
			})
			await expect(follower.send({ id: 2, type: 'destroy' })).resolves.toMatchObject({
				type: 'success',
			})
			expect(bridge.send).not.toHaveBeenCalled()
			follower.terminate()
			stop()
		})
	})
})
