import { describe, expect, test } from 'vitest'
import { BuildSupersededError } from '../errors'
import { WriteGate } from './write-gate'

const builds = { currentBuild: 'A', newerBuild: 'B' }

describe('WriteGate', () => {
	test('admits writes while open and refuses them, unstarted, once closed', async () => {
		const gate = new WriteGate()
		await expect(gate.run({ operation: 'insert' }, async () => 1)).resolves.toBe(1)
		gate.close(builds)
		let started = false
		const refused = gate.run({ collection: 'todos', operation: 'insert' }, async () => {
			started = true
		})
		await expect(refused).rejects.toBeInstanceOf(BuildSupersededError)
		await expect(refused).rejects.toMatchObject({
			code: 'BUILD_SUPERSEDED',
			retriable: true,
			collection: 'todos',
			operation: 'insert',
			context: { currentBuild: 'A', newerBuild: 'B' },
		})
		expect(started).toBe(false)
	})

	test('a write admitted before close is never cancelled and drain waits for it', async () => {
		const gate = new WriteGate()
		let finish: () => void = () => {}
		const admitted = gate.run(
			{ operation: 'transaction' },
			() =>
				new Promise<string>((resolve) => {
					finish = () => resolve('committed')
				}),
		)
		gate.close(builds)
		let drained = false
		const draining = gate.drain().then(() => {
			drained = true
		})
		await Promise.resolve()
		expect(drained).toBe(false)
		expect(gate.pendingCount()).toBe(1)
		finish()
		await expect(admitted).resolves.toBe('committed')
		await draining
		expect(drained).toBe(true)
	})

	test('a failing admitted write rejects to its caller; drain still settles', async () => {
		const gate = new WriteGate()
		const failing = gate.run({ operation: 'execute' }, async () => {
			throw new Error('disk I/O')
		})
		await expect(failing).rejects.toThrow('disk I/O')
		await gate.drain()
		expect(gate.pendingCount()).toBe(0)
	})

	test('a synchronous throw is a rejection, not an exception', async () => {
		const gate = new WriteGate()
		await expect(
			gate.run({ operation: 'execute' }, () => {
				throw new Error('sync')
			}),
		).rejects.toThrow('sync')
	})
})
