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

// Three seeds in the default suite; KORA_CHAOS_SEEDS widens the sample. The nightly run
// (`pnpm test:invariants:nightly`, part of `pnpm chaos:nightly`) uses a fixed list, so a
// failure names a seed that can be replayed.
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

/**
 * Remote deletes each device's apply pipeline judged against a local update (the merge
 * decision behind a delete that is not in the log), by device. Recorded from the merge
 * lifecycle events as they happen, so a later state of the record cannot hide them.
 */
type MergeJudged = Map<TestDevice, Set<string>>

function recordMergeDecisions(network: Network): MergeJudged {
	const judged: MergeJudged = new Map()
	for (const device of network.devices) {
		const ids = new Set<string>()
		judged.set(device, ids)
		device.emitter.on('merge:started', (event) => {
			if (event.type === 'merge:started' && event.operationA.type === 'delete') {
				ids.add(event.operationA.id)
			}
		})
	}
	return judged
}

async function checkInvariants(
	network: Network,
	judged: MergeJudged,
	label: string,
): Promise<void> {
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
			// A remote delete that lost to a later local update is a merge decision, not a
			// dropped operation: the pipeline does not log it. It is recognised from the
			// merge the pipeline ran for it (a delete it judged and did not log lost), not
			// from the record's current state: a later delete of the same record removes
			// the record the losing delete left in place (seed 1117).
			// Anything else must be in the log or the quarantine.
			const mergeLost = op.type === 'delete' && (judged.get(device)?.has(op.id) ?? false)
			expect(
				local.some((candidate) => candidate.id === op.id) || quarantined.has(op.id) || mergeLost,
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
			const judged = recordMergeDecisions(network)

			for (let round = 0; round < ROUNDS; round++) {
				for (const device of network.devices) {
					const ops = 1 + Math.floor(rand() * 4)
					for (let i = 0; i < ops; i++) {
						// Pick by content, not by the random record ids, so a seed picks the same
						// records run after run.
						const rows = sortByContent(await device.getState('todos'))
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
				await checkInvariants(network, judged, `seed ${seed} round ${round}`)
			}

			// Heal: reconnect rounds until every device uploaded everything and converged.
			for (let round = 0; round < 40; round++) {
				for (const device of network.devices) {
					await device.disconnect()
					await device.sync()
				}
				await checkInvariants(network, judged, `seed ${seed} heal ${round}`)
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

/** Rows in an order that does not depend on their (random) ids, as far as content allows. */
function sortByContent(rows: Record<string, unknown>[]): Record<string, unknown>[] {
	const key = (row: Record<string, unknown>): string =>
		`${String(row.title)}\u0000${String(row.done)}\u0000${String(row.rank).padStart(4, '0')}`
	return [...rows].sort((a, b) => {
		const ka = key(a)
		const kb = key(b)
		if (ka !== kb) return ka < kb ? -1 : 1
		return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
	})
}
