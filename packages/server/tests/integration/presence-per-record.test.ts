/**
 * F16: presence (awareness) is relayed per record, not per identical download scope.
 *
 * Three signed-in users hold different grants that overlap on one shared document,
 * plus an anonymous share visitor whose grant names that document only. A cursor on
 * the shared document reaches everyone who can read it; a cursor on a record a
 * receiver cannot read never reaches that receiver; presence without a cursor, a
 * malformed cursor, or a cursor on a record the SENDER cannot read reaches nobody
 * outside the sender's own presence partition.
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres and
 * KORA_PG_TEST_URL set (see rt-fixture.ts).
 */
import { defineSchema, t } from '@korajs/core'
import type { AwarenessStateWire, SyncMessage } from '@korajs/sync'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { MixedAuthProvider } from '../../src/auth/mixed-auth-provider'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { type Harness, type TestClient, createHarness, tick } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		docs: { fields: { spaceId: t.string(), title: t.string() } },
	},
})

const SPACES: Record<string, string[]> = {
	alice: ['user:alice', 'doc:shared', 'doc:alice-bob-private'],
	bob: ['user:bob', 'doc:shared', 'doc:alice-bob-private'],
	carol: ['user:carol', 'doc:shared'],
}

const primary = new TokenAuthProvider({
	validate: async (token) => {
		const spaces = SPACES[token]
		if (!spaces) return null
		return { userId: token, scopes: { docs: { spaceId: { $in: spaces } } } }
	},
})

// Share-link visitors read exactly the shared document, by id.
const auth = new MixedAuthProvider({
	primary,
	anonymousScopes: { docs: { id: 'rec-shared' } },
})

const CLIENT_IDS = { alice: 1, bob: 2, carol: 3, anon: 4 } as const

function presence(
	name: string,
	cursor?: { collection: unknown; recordId: unknown },
): AwarenessStateWire {
	return {
		user: { name, color: '#000' },
		...(cursor
			? {
					cursor: { field: 'title', anchor: 0, head: 0, ...cursor } as AwarenessStateWire['cursor'],
				}
			: {}),
	}
}

function on(recordId: string): { collection: string; recordId: string } {
	return { collection: 'docs', recordId }
}

let messageCounter = 0
function publish(client: TestClient, clientId: number, state: AwarenessStateWire | null): void {
	messageCounter += 1
	client.send({
		type: 'awareness-update',
		messageId: `aw-${messageCounter}`,
		clientId,
		states: { [String(clientId)]: state },
	} as SyncMessage)
}

/** Every value of `clientId`'s entry a client received since `from`, in order. */
function seen(client: TestClient, clientId: number, from = 0): Array<AwarenessStateWire | null> {
	const out: Array<AwarenessStateWire | null> = []
	for (const m of client.messages.slice(from)) {
		if (m.type !== 'awareness-update') continue
		const states = m.states as Record<string, AwarenessStateWire | null>
		if (String(clientId) in states) out.push(states[String(clientId)] ?? null)
	}
	return out
}

/** The presence a client currently shows for `clientId`: the last entry it received. */
function shown(client: TestClient, clientId: number): AwarenessStateWire | null {
	const all = seen(client, clientId)
	return all.length > 0 ? (all[all.length - 1] ?? null) : null
}

interface Party {
	alice: TestClient
	bob: TestClient
	carol: TestClient
	anon: TestClient
}

let harness: Harness
let party: Party

async function insertDoc(recordId: string, spaceId: string): Promise<void> {
	const result = await harness.server.getKoraContext().apply({
		collection: 'docs',
		type: 'insert',
		recordId,
		data: { spaceId, title: recordId },
	})
	expect(result.ok).toBe(true)
}

beforeEach(async () => {
	harness = await createHarness(schema, auth)
	await insertDoc('rec-shared', 'doc:shared')
	await insertDoc('rec-ab', 'doc:alice-bob-private')
	await insertDoc('rec-alice', 'user:alice')
	party = {
		alice: await harness.login('alice', 'node-alice'),
		bob: await harness.login('bob', 'node-bob'),
		carol: await harness.login('carol', 'node-carol'),
		anon: await harness.login('', 'node-anon'),
	}
	for (const [name, client] of Object.entries(party) as Array<[string, TestClient]>) {
		expect(
			client.messages.some((m: SyncMessage) => m.type === 'handshake-response' && m.accepted),
		).toBe(true)
		// Each client publishes presence without a cursor first (registration), as the
		// real client does when it connects with a user set.
		publish(client, CLIENT_IDS[name as keyof Party], presence(name))
	}
	await tick()
})

describe('F16: presence relayed per record', () => {
	test('presence without a cursor never crosses different grants or reaches anonymous visitors', () => {
		for (const [name, client] of Object.entries(party)) {
			for (const [other, id] of Object.entries(CLIENT_IDS)) {
				if (other === name) continue
				expect(seen(client, id), `${name} saw ${other}`).toEqual([])
			}
		}
	})

	test('a cursor on the shared record reaches every session that can read it', async () => {
		publish(party.alice, CLIENT_IDS.alice, presence('alice', on('rec-shared')))
		await vi.waitFor(() => {
			expect(shown(party.bob, CLIENT_IDS.alice)?.cursor?.recordId).toBe('rec-shared')
			expect(shown(party.carol, CLIENT_IDS.alice)?.cursor?.recordId).toBe('rec-shared')
			expect(shown(party.anon, CLIENT_IDS.alice)?.cursor?.recordId).toBe('rec-shared')
		})

		// The anonymous visitor on the shared record is seen there, and only there.
		publish(party.anon, CLIENT_IDS.anon, presence('visitor', on('rec-shared')))
		await vi.waitFor(() => {
			expect(shown(party.alice, CLIENT_IDS.anon)?.user.name).toBe('visitor')
			expect(shown(party.carol, CLIENT_IDS.anon)?.user.name).toBe('visitor')
		})
	})

	test('a cursor on a record outside a receiver grant never reaches it; moving away removes it', async () => {
		publish(party.alice, CLIENT_IDS.alice, presence('alice', on('rec-shared')))
		await vi.waitFor(() => expect(shown(party.carol, CLIENT_IDS.alice)).not.toBeNull())
		const marks = {
			bob: party.bob.messages.length,
			carol: party.carol.messages.length,
			anon: party.anon.messages.length,
		}

		// Alice moves to the document only she and Bob share.
		publish(party.alice, CLIENT_IDS.alice, presence('alice', on('rec-ab')))
		await vi.waitFor(() =>
			expect(shown(party.bob, CLIENT_IDS.alice)?.cursor?.recordId).toBe('rec-ab'),
		)
		await tick()
		// Carol and the visitor are told Alice left the shared record, never where she went.
		expect(seen(party.carol, CLIENT_IDS.alice, marks.carol)).toEqual([null])
		expect(seen(party.anon, CLIENT_IDS.alice, marks.anon)).toEqual([null])

		// Her personal document: nobody else may read it.
		publish(party.alice, CLIENT_IDS.alice, presence('alice', on('rec-alice')))
		await vi.waitFor(() => expect(shown(party.bob, CLIENT_IDS.alice)).toBeNull())
		await tick()
		expect(seen(party.carol, CLIENT_IDS.alice, marks.carol)).toEqual([null])
		expect(seen(party.anon, CLIENT_IDS.alice, marks.anon)).toEqual([null])
		const leakedTo = [party.bob, party.carol, party.anon].filter((c) =>
			c.messages.some(
				(m) => m.type === 'awareness-update' && JSON.stringify(m.states).includes('rec-alice'),
			),
		)
		expect(leakedTo).toEqual([])
		expect(marks.bob).toBeGreaterThan(0)
	})

	test('a cursor on a record the sender cannot read reaches nobody', async () => {
		// Carol cannot read rec-ab; Alice and Bob can. Carol must not appear there.
		publish(party.carol, CLIENT_IDS.carol, presence('carol', on('rec-ab')))
		// A cursor on a record that does not exist, and malformed cursors, too.
		publish(party.anon, CLIENT_IDS.anon, presence('visitor', on('rec-ab')))
		publish(party.bob, CLIENT_IDS.bob, presence('bob', on('rec-missing')))
		await tick()
		publish(party.bob, CLIENT_IDS.bob, presence('bob', { collection: 'docs', recordId: 42 }))
		await tick()
		publish(party.bob, CLIENT_IDS.bob, presence('bob', { collection: ['docs'], recordId: 'x' }))
		await tick()
		for (const client of Object.values(party)) {
			expect(seen(client, CLIENT_IDS.carol)).toEqual([])
			expect(seen(client, CLIENT_IDS.anon)).toEqual([])
			expect(seen(client, CLIENT_IDS.bob)).toEqual([])
		}
	})

	test('catch-up and disconnect follow the same per-record rule', async () => {
		publish(party.alice, CLIENT_IDS.alice, presence('alice', on('rec-ab')))
		publish(party.bob, CLIENT_IDS.bob, presence('bob', on('rec-shared')))
		await vi.waitFor(() => expect(shown(party.carol, CLIENT_IDS.bob)).not.toBeNull())

		// A second Carol device joins: it catches up on Bob (shared record), not Alice.
		const carol2 = await harness.login('carol', 'node-carol-2')
		publish(carol2, 5, presence('carol'))
		await vi.waitFor(() => expect(shown(carol2, CLIENT_IDS.bob)?.user.name).toBe('bob'))
		expect(seen(carol2, CLIENT_IDS.alice)).toEqual([])

		// Bob leaves: everyone shown his cursor gets the removal; nobody else is told.
		const aliceMark = party.alice.messages.length
		party.bob.client.disconnect()
		await vi.waitFor(() => {
			expect(shown(party.carol, CLIENT_IDS.bob)).toBeNull()
			expect(shown(carol2, CLIENT_IDS.bob)).toBeNull()
			expect(shown(party.anon, CLIENT_IDS.bob)).toBeNull()
			expect(shown(party.alice, CLIENT_IDS.bob)).toBeNull()
		})
		expect(seen(party.alice, CLIENT_IDS.bob, aliceMark)).toEqual([null])
	})

	test('a sender cannot publish for another client id', async () => {
		party.bob.send({
			type: 'awareness-update',
			messageId: 'forged',
			clientId: CLIENT_IDS.bob,
			states: { [String(CLIENT_IDS.alice)]: presence('mallory', on('rec-shared')) },
		} as SyncMessage)
		await tick()
		for (const client of Object.values(party)) expect(seen(client, CLIENT_IDS.alice)).toEqual([])
	})
})

describe('F16: presence cursor lookups are bounded', () => {
	test('repeated cursor moves on one record read the store once; distinct records are budgeted', async () => {
		const reads = vi.spyOn(harness.store, 'queryCollection')
		for (let i = 0; i < 50; i++) {
			publish(party.alice, CLIENT_IDS.alice, presence('alice', on('rec-shared')))
		}
		await vi.waitFor(() => expect(shown(party.bob, CLIENT_IDS.alice)).not.toBeNull())
		await tick()
		expect(reads.mock.calls.filter(([c]) => c === 'docs').length).toBeLessThanOrEqual(1)

		reads.mockClear()
		for (let i = 0; i < 1_300; i++) {
			publish(party.carol, CLIENT_IDS.carol, presence('carol', on(`probe-${i}`)))
		}
		// Every update is processed in order; the budget stops the reads at 1,200.
		await vi.waitFor(() => expect(reads.mock.calls.length).toBe(1_200), { timeout: 20_000 })
		await tick(200)
		expect(reads.mock.calls.length).toBe(1_200)
		reads.mockRestore()
	})
})
