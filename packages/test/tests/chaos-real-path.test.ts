import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { checkConvergence, createTestNetwork, expectConverged } from '../src'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

const CLIENT_COUNT = 3
const OPS_PER_CLIENT = 20

describe('chaos real-path convergence (Store + MergeAware + TestServer)', () => {
	let closeNetwork: (() => Promise<void>) | null = null

	afterEach(async () => {
		if (closeNetwork) {
			await closeNetwork()
			closeNetwork = null
		}
	})

	test('clients converge under lossy transport', async () => {
		const network = await createTestNetwork(schema, {
			devices: CLIENT_COUNT,
			chaos: {
				dropRate: 0.1,
				duplicateRate: 0.05,
				reorderRate: 0.05,
				maxLatency: 10,
				randomSource: seededRandom(42),
			},
		})
		closeNetwork = () => network.close()

		for (let index = 0; index < network.devices.length; index++) {
			const device = network.devices[index]
			if (!device) {
				continue
			}
			for (let op = 0; op < OPS_PER_CLIENT; op++) {
				await device.collection('todos').insert({
					title: `todo-${index}-${op}`,
				})
			}
			await device.sync()
		}

		for (const device of network.devices) {
			await device.disconnect()
			await device.sync()
		}

		await expectConverged(network.devices, schema)

		const serverCount = network.server.getAllOperations().length
		expect(serverCount).toBe(CLIENT_COUNT * OPS_PER_CLIENT)
	})

	test('contended workload (updates, deletes, same records) converges under chaos', async () => {
		const network = await createTestNetwork(schema, {
			devices: CLIENT_COUNT,
			chaos: {
				dropRate: 0.1,
				duplicateRate: 0.05,
				reorderRate: 0.1,
				maxLatency: 10,
				randomSource: seededRandom(1337),
			},
		})
		closeNetwork = () => network.close()

		const [seeder] = network.devices
		if (!seeder) {
			throw new Error('missing seed device')
		}

		// Shared records every client will fight over.
		const sharedIds: string[] = []
		for (let i = 0; i < 5; i++) {
			const rec = await seeder.collection('todos').insert({ title: `shared-${i}` })
			sharedIds.push(rec.id)
		}
		await seeder.sync()
		// Heal seed-phase drops: retry until every device sees every shared record
		// (chaos can drop the initial relay).
		for (let round = 0; round < 10; round++) {
			let allSeeded = true
			for (const device of network.devices) {
				await device.disconnect()
				await device.sync()
				for (const id of sharedIds) {
					if ((await device.collection('todos').findById(id)) === null) {
						allSeeded = false
					}
				}
			}
			if (allSeeded) {
				break
			}
		}

		// Mixed contended workload: same-field updates on shared records from
		// every client, a contended delete, plus fresh inserts — all while the
		// transport drops, duplicates, and REORDERS messages (reordering is what
		// forces update-before-insert delivery on some receiver).
		const rand = seededRandom(7)
		for (let index = 0; index < network.devices.length; index++) {
			const device = network.devices[index]
			if (!device) {
				continue
			}
			for (let i = 0; i < sharedIds.length; i++) {
				const id = sharedIds[i]
				if (!id) {
					continue
				}
				if (i === sharedIds.length - 1) {
					// Everyone tries to delete the last shared record.
					try {
						await device.collection('todos').delete(id)
					} catch {
						// Another client's relayed delete may have landed first.
					}
				} else {
					await device.collection('todos').update(id, {
						title: `edit-${index}-${Math.floor(rand() * 1000)}`,
						completed: rand() > 0.5,
					})
				}
			}
			await device.collection('todos').insert({ title: `own-${index}` })
			await device.sync()
		}

		// Extra exchange rounds so dropped messages get retried to a fixpoint.
		// Sync uses version-vector reconciliation, so each round is a fresh,
		// idempotent chance for a chaos-dropped op to get resent, but how many
		// rounds that takes depends on real event-loop scheduling (chaos
		// latency is real setTimeout delay), not just the seeded drop/reorder
		// decisions. A fixed round count assumes those rounds always do enough
		// real work in time, which is exactly the kind of timing dependency
		// CLAUDE.md rules out. Mirror the seed-phase healing loop above: check
		// actual convergence after each round and stop as soon as it holds,
		// with generous headroom (30 rounds) for a slow/contended machine.
		for (let round = 0; round < 30; round++) {
			for (const device of network.devices) {
				await device.disconnect()
				await device.sync()
			}
			const result = await checkConvergence(network.devices, schema)
			if (result.converged) {
				break
			}
		}

		await expectConverged(network.devices, schema)

		// The contended-delete record is gone everywhere.
		const lastShared = sharedIds[sharedIds.length - 1]
		for (const device of network.devices) {
			const rec = await device.collection('todos').findById(lastShared ?? '')
			expect(rec).toBeNull()
		}
	}, 90000)
})

function seededRandom(seed: number): () => number {
	let state = seed
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff
		return state / 0x7fffffff
	}
}
