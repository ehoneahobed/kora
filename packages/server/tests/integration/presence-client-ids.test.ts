import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { AwarenessManager } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { type Harness, type TestClient, createHarness } from '../repro/rt-fixture'

/**
 * Every browser page used to number its awareness client from 1, so two pages announced the
 * same id: each dropped the other's presence as its own echo, and a third page saw both in
 * one slot. The server relays every session under an id no other connected session uses.
 */
const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

let harness: Harness | null = null
afterEach(async () => {
	await harness?.server.stop()
	harness = null
})

function publish(c: TestClient, clientId: number, name: string | null): void {
	c.send({
		type: 'awareness-update',
		messageId: `aw-${name}-${Math.random()}`,
		clientId,
		states: { [String(clientId)]: name === null ? null : ({ user: { name } } as never) },
	} as SyncMessage)
}

/** What a real client on `c` sees (its own id is `ownId`), by feeding it every update. */
function seenBy(c: TestClient, ownId: number): string[] {
	const manager = new AwarenessManager({ clientId: ownId })
	for (const m of c.messages) {
		if (m.type === 'awareness-update')
			manager.handleRemoteMessage({
				type: 'awareness',
				clientId: m.clientId,
				states: m.states as never,
			})
	}
	return [...manager.getStates().values()]
		.map((s) => (s as { user: { name: string } }).user.name)
		.sort()
}

describe('presence when sessions announce the same awareness id', () => {
	test('two pages that both announce id 1 see each other, and a third sees both', async () => {
		harness = await createHarness(schema, null)
		const a = await harness.login('anyone', 'node-a')
		const b = await harness.login('anyone', 'node-b')
		const c = await harness.login('anyone', 'node-c')
		publish(a, 1, 'Ann')
		await harness.settle()
		publish(b, 1, 'Bob')
		await harness.settle()
		publish(c, 7, 'Cat')
		await harness.settle()
		expect(seenBy(a, 1)).toEqual(['Bob', 'Cat'])
		expect(seenBy(b, 1)).toEqual(['Ann', 'Cat'])
		expect(seenBy(c, 7)).toEqual(['Ann', 'Bob'])
	})

	test('one page leaving removes only its own presence for the others', async () => {
		harness = await createHarness(schema, null)
		const a = await harness.login('anyone', 'node-a')
		const b = await harness.login('anyone', 'node-b')
		const c = await harness.login('anyone', 'node-c')
		// A session joins presence when it first publishes (as a real client does).
		publish(c, 7, 'Cat')
		await harness.settle()
		publish(a, 1, 'Ann')
		publish(b, 1, 'Bob')
		await harness.settle()
		expect(seenBy(c, 7)).toEqual(['Ann', 'Bob'])
		await a.client.disconnect()
		await harness.settle()
		expect(seenBy(c, 7)).toEqual(['Bob'])
	})
})
