import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice, TestNetwork } from '../../src/index'
import { createTestNetwork } from '../../src/index'

/**
 * SRV-3 repro: a streaming delivery push resumes from the last ACKNOWLEDGED delivery
 * sequence, so every relay wake-up re-sends the whole unacknowledged backlog. A
 * burst of N writes from one device should cost a streaming peer ~N operations on the
 * wire, not a multiple of N.
 */
const LAT = Number(process.env.SRV3_LAT ?? 20)
const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string() } } },
})

let network: TestNetwork | null = null
afterEach(async () => {
	if (network) {
		await network.close()
		network = null
	}
})

describe('SRV-3 delivery stream re-sends unacked backlog on every push', () => {
	test('a write during a fresh peer\'s initial sync does not re-send the whole backlog', async () => {
		const counters: Array<{ ops: number }> = []
		network = await createTestNetwork(schema, {
			devices: 2,
			wrapTransport(pair) {
				const counter = { ops: 0 }
				counters.push(counter)
				const st = pair.serverTransport
				return {
					client: pair.client,
					serverTransport: {
						send(m: SyncMessage) {
							if (m.type === 'operation-batch') counter.ops += m.operations.length
							st.send(m)
						},
						onMessage: (h) => st.onMessage((m) => void setTimeout(() => h(m), LAT)),
						onClose: (h) => st.onClose(h),
						onError: (h) => st.onError(h),
						isConnected: () => st.isConnected(),
						close: (c, r) => st.close(c, r),
					},
				}
			},
		})
		const [a, b] = network.devices as TestDevice[]
		await a.sync()
		const BACKLOG = 400
		for (let i = 0; i < BACKLOG; i++) await a.collection('notes').insert({ body: `b${i}` })
		await a.sync()
		const initial = b.sync()
		for (let i = 0; i < 5; i++) {
			await new Promise((r) => setTimeout(r, 3))
			await a.collection('notes').insert({ body: `live${i}` })
		}
		await initial
		for (let r = 0; r < 3; r++) {
			await a.sync()
			await b.sync()
		}
		const bCounter = counters[1]
		expect((await b.getState('notes')).length).toBe(BACKLOG + 5)
		console.log(`SRV-3 initial-sync backlog=${BACKLOG}+5 opsSentToB=${bCounter?.ops} amplification=${((bCounter?.ops ?? 0) / (BACKLOG + 5)).toFixed(2)}x`)
		expect(bCounter?.ops ?? 0).toBeLessThanOrEqual(Math.ceil((BACKLOG + 5) * 1.2))
	}, 120000)

	test('burst of N writes (20ms uplink latency) reaches a streaming peer with ~N ops on the wire', async () => {
		const perPair: Array<{ ops: number; bytes: number; batches: number }> = []
		network = await createTestNetwork(schema, {
			devices: 2,
			wrapTransport(pair) {
				const counter = { ops: 0, bytes: 0, batches: 0 }
				perPair.push(counter)
				const st = pair.serverTransport
				return {
					client: pair.client,
					serverTransport: {
						send(m: SyncMessage) {
							if (m.type === 'operation-batch') {
								counter.batches++
								counter.ops += m.operations.length
								counter.bytes += JSON.stringify(m).length
							}
							st.send(m)
						},
						// Model a real network RTT on this client's uplink (acks arrive ~20ms later).
						onMessage: (h) => st.onMessage((m) => void setTimeout(() => h(m), LAT)),
						onClose: (h) => st.onClose(h),
						onError: (h) => st.onError(h),
						isConnected: () => st.isConnected(),
						close: (c, r) => st.close(c, r),
					},
				}
			},
		})
		const [a, b] = network.devices as TestDevice[]
		await a.sync()
		await b.sync()
		const bCounter = perPair[1]
		if (!bCounter) throw new Error('missing counter')
		bCounter.ops = 0
		bCounter.bytes = 0
		bCounter.batches = 0

		const N = 50
		// A steady stream of writes, one every ~2ms (faster than one uplink RTT).
		for (let i = 0; i < N; i++) {
			await a.collection('notes').insert({ body: `n${i}-${'x'.repeat(200)}` })
			await new Promise((r) => setTimeout(r, 2))
		}
		for (let r = 0; r < 3; r++) {
			await a.sync()
			await b.sync()
		}
		expect((await b.getState('notes')).length).toBe(N)
		console.log(`SRV-3 N=${N} opsSentToB=${bCounter.ops} batches=${bCounter.batches} bytes=${bCounter.bytes} amplification=${(bCounter.ops / N).toFixed(2)}x`)
		expect(bCounter.ops).toBeLessThanOrEqual(Math.ceil(N * 1.2))
	}, 60000)
})
