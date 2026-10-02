/**
 * Phase 2 "no silent data loss" invariants (W3 upstream, W4 downstream), checked at
 * every checkpoint of seeded random workloads over a lossy network (drop, duplicate,
 * reorder), then after healing:
 *
 *  U. Upload: no own operation is counted synced unless the server stored it or it was
 *     terminally rejected and recorded. Concretely, every own operation at or below the
 *     device's contiguous acknowledged prefix is on the server or in the rejected store.
 *  D. Download: the delivery watermark never passes an operation that was neither
 *     applied nor quarantined. Every server operation with a delivery sequence at or
 *     below the device's watermark is in the device's op log or its quarantine.
 *  C. All replicas converge (scalar fields; array/object divergence is MERGE-2).
 *
 * Each seed is a deterministic workload; the seeds play the role of property-test
 * samples (a fixed set keeps the suite reproducible and within CI time).
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { checkConvergence, createTestNetwork, expectConverged } from '../src'
import type { TestDevice } from '../src'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
				rank: t.number().default(0),
			},
		},
	},
})

// Three seeds in the default suite; KORA_CHAOS_SEEDS widens the sample (nightly).
const SEEDS = (process.env.KORA_CHAOS_SEEDS ?? '11,23,37').split(',').map(Number)
const DEVICES = 3
const ROUNDS = 5

interface EngineInternals {
	ownAckedThrough: number
	getStatus(): { deliveryWatermark: number; pendingOperations: number }
	getRejectedOperations(): Promise<Array<{ operationId: string }>>
	getQuarantinedOperations(): Promise<Array<{ operation: Operation }>>
}

function engineOf(device: TestDevice): EngineInternals | null {
	return device.getSyncEngine() as unknown as EngineInternals | null
}

type Network = Awaited<ReturnType<typeof createTestNetwork>>

async function checkInvariants(network: Network, label: string): Promise<void> {
	const serverOps = await network.server.store.getOperationsAfterDelivery(0, 1_000_000)
	const serverIds = new Set(serverOps.map((entry) => entry.operation.id))
	for (const device of network.devices) {
		const engine = engineOf(device)
		if (!engine) continue
		const nodeId = device.getNodeId()

		// U: the acknowledged prefix covers only stored or recorded-rejected ops.
		const prefix = engine.ownAckedThrough
		if (prefix > 0) {
			const rejected = new Set((await engine.getRejectedOperations()).map((r) => r.operationId))
			const own = await device.store.getOperationRange(nodeId, 1, prefix)
			for (const op of own) {
				expect(
					serverIds.has(op.id) || rejected.has(op.id),
					`${label}: ${device.name} counts own seq ${op.sequenceNumber} synced, but the server lacks it`,
				).toBe(true)
			}
		}

		// D: nothing at or below the watermark is missing without a quarantine record.
		const watermark = engine.getStatus().deliveryWatermark
		const quarantined = new Set(
			(await engine.getQuarantinedOperations()).map((entry) => entry.operation.id),
		)
		for (const entry of serverOps) {
			if (entry.deliverySequence > watermark || entry.operation.nodeId === nodeId) continue
			const op = entry.operation
			const local = await device.store.getOperationRange(
				op.nodeId,
				op.sequenceNumber,
				op.sequenceNumber,
			)
			// A remote delete that lost to a later local update is a merge decision (the
			// record is settled and stays), not a dropped operation; the pipeline does not
			// log it. Anything else must be in the log or the quarantine.
			const mergeKeptRecord =
				op.type === 'delete' &&
				(await device.collection(op.collection).findById(op.recordId)) !== null
			expect(
				local.some((candidate) => candidate.id === op.id) ||
					quarantined.has(op.id) ||
					mergeKeptRecord,
				`${label}: ${device.name} watermark ${watermark} passed delivery ${entry.deliverySequence} (${op.id}) without applying or quarantining it (${op.type} ${op.collection}/${op.recordId})`,
			).toBe(true)
		}
	}
}

describe('no silent loss: upload prefix, download watermark, convergence under chaos', () => {
	let close: (() => Promise<void>) | null = null
	afterEach(async () => {
		await close?.()
		close = null
	})

	for (const seed of SEEDS) {
		test(`seed ${seed}: invariants hold at every checkpoint and replicas converge`, async () => {
			const rand = seededRandom(seed)
			const network = await createTestNetwork(schema, {
				devices: DEVICES,
				chaos: {
					dropRate: 0.15,
					duplicateRate: 0.1,
					reorderRate: 0.15,
					maxLatency: 5,
					randomSource: seededRandom(seed * 7919),
				},
			})
			close = () => network.close()

			for (let round = 0; round < ROUNDS; round++) {
				for (const device of network.devices) {
					const ops = 1 + Math.floor(rand() * 4)
					for (let i = 0; i < ops; i++) {
						const rows = await device.getState('todos')
						const pick = rows[Math.floor(rand() * rows.length)]
						const roll = rand()
						if (!pick || roll < 0.4) {
							await device.collection('todos').insert({ title: `r${round}-${device.name}-${i}` })
						} else if (roll < 0.9) {
							await device.collection('todos').update(pick.id as string, {
								title: `edit-${seed}-${round}-${i}`,
								done: rand() < 0.5,
								rank: Math.floor(rand() * 100),
							})
						} else {
							try {
								await device.collection('todos').delete(pick.id as string)
							} catch {
								// Already deleted by a relayed operation.
							}
						}
					}
					if (rand() < 0.3) await device.disconnect()
					await device.sync()
				}
				await checkInvariants(network, `seed ${seed} round ${round}`)
			}

			// Heal: reconnect rounds until every device uploaded everything and converged.
			for (let round = 0; round < 40; round++) {
				for (const device of network.devices) {
					await device.disconnect()
					await device.sync()
				}
				await checkInvariants(network, `seed ${seed} heal ${round}`)
				const settled = network.devices.every((device) => {
					const engine = engineOf(device)
					return (
						engine !== null &&
						engine.getStatus().pendingOperations === 0 &&
						engine.ownAckedThrough === (device.getVersionVector().get(device.getNodeId()) ?? 0)
					)
				})
				if (settled && (await checkConvergence(network.devices, schema)).converged) break
			}

			await expectConverged(network.devices, schema)
			const serverIds = new Set(network.server.getAllOperations().map((op) => op.id))
			for (const device of network.devices) {
				const nodeId = device.getNodeId()
				const localSeq = device.getVersionVector().get(nodeId) ?? 0
				const own = await device.store.getOperationRange(nodeId, 1, localSeq)
				for (const op of own) {
					expect(
						serverIds.has(op.id),
						`${device.name} op ${op.sequenceNumber} never reached the server`,
					).toBe(true)
				}
				expect(engineOf(device)?.getStatus().pendingOperations).toBe(0)
			}
		}, 120_000)
	}
})

function seededRandom(seed: number): () => number {
	let state = seed
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff
		return state / 0x7fffffff
	}
}
