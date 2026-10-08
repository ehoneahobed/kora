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

	test('a record that moves out of a grant takes the presence on it out too', async () => {
		publish(party.bob, CLIENT_IDS.bob, presence('bob', on('rec-shared')))
		await vi.waitFor(() => expect(shown(party.carol, CLIENT_IDS.bob)).not.toBeNull())
		// The shared document moves to the space only Alice and Bob share: Carol can no
		// longer read it, so Bob's presence there is withdrawn from her. The visitor's
		// grant names the record by id, so it still reads it and still sees Bob.
		const moved = await harness.server.getKoraContext().apply({
			collection: 'docs',
			type: 'update',
			recordId: 'rec-shared',
			data: { spaceId: 'doc:alice-bob-private' },
		})
		expect(moved.ok).toBe(true)
		await vi.waitFor(() => expect(shown(party.carol, CLIENT_IDS.bob)).toBeNull())
		expect(shown(party.alice, CLIENT_IDS.bob)?.cursor?.recordId).toBe('rec-shared')
		expect(shown(party.anon, CLIENT_IDS.bob)?.cursor?.recordId).toBe('rec-shared')
		// A Carol device that joins now does not catch up on it either.
		const carol2 = await harness.login('carol', 'node-carol-2')
		publish(carol2, 5, presence('carol'))
		await tick()
		expect(seen(carol2, CLIENT_IDS.bob)).toEqual([])
		// Moving back makes it visible again without a new update from Bob.
		const back = await harness.server.getKoraContext().apply({
			collection: 'docs',
			type: 'update',
			recordId: 'rec-shared',
			data: { spaceId: 'doc:shared' },
		})
		expect(back.ok).toBe(true)
		await vi.waitFor(() =>
			expect(shown(party.carol, CLIENT_IDS.bob)?.cursor?.recordId).toBe('rec-shared'),
		)
	})

	test('an update the relay drops does not repoint the sender presence at another record', async () => {
		publish(party.alice, CLIENT_IDS.alice, presence('alice', on('rec-alice')))
		await tick()
		// Stamped with Bob's id: the relay drops it, so it must not move Alice's presence
		// (still on her personal document) to the shared one.
		party.alice.send({
			type: 'awareness-update',
			messageId: 'mislabelled',
			clientId: CLIENT_IDS.bob,
			states: { [String(CLIENT_IDS.bob)]: presence('alice', on('rec-shared')) },
		} as SyncMessage)
		await tick()
		// A write to the shared record re-decides the presence on it.
		const touched = await harness.server.getKoraContext().apply({
			collection: 'docs',
			type: 'update',
			recordId: 'rec-shared',
			data: { title: 'touched' },
		})
		expect(touched.ok).toBe(true)
		await tick(100)
		for (const client of [party.bob, party.carol, party.anon]) {
			expect(seen(client, CLIENT_IDS.alice)).toEqual([])
		}
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

/** A promise and the function that resolves it. */
function gate(): { wait: Promise<void>; open: () => void } {
	let open = (): void => {}
	const wait = new Promise<void>((resolve) => {
		open = resolve
	})
	return { wait, open }
}

function readsOf(calls: unknown[][], recordId: string): number {
	return calls.filter(([collection, options]) => {
		const where = (options as { where?: { id?: unknown } } | undefined)?.where
		return collection === 'docs' && where?.id === recordId
	}).length
}

describe('F16: presence decisions follow the latest stored record', () => {
	test('a record moved while the cursor owner filters a delivery chunk withdraws its presence (no delivery-cache reuse)', async () => {
		// rec-m starts in Carol's personal space, so the delivery pass of Alice's
		// watermark device treats its move into the shared space as a scope entry and
		// caches its row for the whole chunk.
		await insertDoc('rec-m', 'user:carol')
		const alice = await harness.login('alice', 'node-alice-stream', {
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>)
		const ALICE = 6
		publish(alice, ALICE, presence('alice'))
		await tick()
		const held = gate()
		const real = harness.store.getRecordFieldVersions.bind(harness.store)
		const versions = vi
			.spyOn(harness.store, 'getRecordFieldVersions')
			.mockImplementation(async (collection, recordId) => {
				if (recordId === 'rec-m') await held.wait
				return real(collection, recordId)
			})
		const ctx = harness.server.getKoraContext()
		try {
			expect(
				(
					await ctx.apply({
						collection: 'docs',
						type: 'update',
						recordId: 'rec-m',
						data: { spaceId: 'doc:shared' },
					})
				).ok,
			).toBe(true)
			// The delivery pass is now held inside its scope-entry decision for rec-m.
			await vi.waitFor(() => expect(versions).toHaveBeenCalled())

			publish(alice, ALICE, presence('alice', on('rec-m')))
			await vi.waitFor(() => expect(shown(party.carol, ALICE)?.cursor?.recordId).toBe('rec-m'))

			// rec-m moves to the space only Alice and Bob share: Carol must lose Alice's
			// presence there, even though the held pass still holds the pre-move row.
			expect(
				(
					await ctx.apply({
						collection: 'docs',
						type: 'update',
						recordId: 'rec-m',
						data: { spaceId: 'doc:alice-bob-private' },
					})
				).ok,
			).toBe(true)
			await vi.waitFor(() => expect(shown(party.carol, ALICE)).toBeNull())
			expect(shown(party.bob, ALICE)?.cursor?.recordId).toBe('rec-m')
		} finally {
			held.open()
			await tick()
			versions.mockRestore()
		}
		expect(shown(party.carol, ALICE)).toBeNull()
	})

	test('an older audience read that finishes last never overrides a newer one', async () => {
		publish(party.bob, CLIENT_IDS.bob, presence('bob', on('rec-shared')))
		await vi.waitFor(() => expect(shown(party.carol, CLIENT_IDS.bob)).not.toBeNull())
		const ctx = harness.server.getKoraContext()

		// The read that follows the first write sees the record still shared, and is held.
		const held = gate()
		const real = harness.store.queryCollection.bind(harness.store)
		let armed = true
		const reads = vi.spyOn(harness.store, 'queryCollection').mockImplementation(async (...args) => {
			const rows = await real(...args)
			const where = (args[1] as { where?: { id?: unknown } } | undefined)?.where
			if (armed && args[0] === 'docs' && where?.id === 'rec-shared') {
				armed = false
				await held.wait
			}
			return rows
		})
		try {
			expect(
				(
					await ctx.apply({
						collection: 'docs',
						type: 'update',
						recordId: 'rec-shared',
						data: { title: 'renamed' },
					})
				).ok,
			).toBe(true)
			await vi.waitFor(() => expect(armed).toBe(false))
			// The second write moves it out of Carol's grant.
			expect(
				(
					await ctx.apply({
						collection: 'docs',
						type: 'update',
						recordId: 'rec-shared',
						data: { spaceId: 'doc:alice-bob-private' },
					})
				).ok,
			).toBe(true)
			await tick()
			held.open()
			await vi.waitFor(() => expect(shown(party.carol, CLIENT_IDS.bob)).toBeNull())
			await tick(100)
			// The late read of the shared state did not hand Bob's presence back to Carol.
			expect(shown(party.carol, CLIENT_IDS.bob)).toBeNull()
			expect(shown(party.alice, CLIENT_IDS.bob)?.cursor?.recordId).toBe('rec-shared')
		} finally {
			held.open()
			reads.mockRestore()
		}
	})

	test('a cursor whose record moves while its own lookup runs is judged on the moved record', async () => {
		publish(party.alice, CLIENT_IDS.alice, presence('alice', on('rec-ab')))
		await vi.waitFor(() =>
			expect(shown(party.bob, CLIENT_IDS.alice)?.cursor?.recordId).toBe('rec-ab'),
		)
		const carolMark = party.carol.messages.length
		const ctx = harness.server.getKoraContext()

		// Alice's cursor moves to rec-shared; the lookup reads it still shared and is held.
		const held = gate()
		const real = harness.store.queryCollection.bind(harness.store)
		let armed = true
		const reads = vi.spyOn(harness.store, 'queryCollection').mockImplementation(async (...args) => {
			const rows = await real(...args)
			const where = (args[1] as { where?: { id?: unknown } } | undefined)?.where
			if (armed && args[0] === 'docs' && where?.id === 'rec-shared') {
				armed = false
				await held.wait
			}
			return rows
		})
		try {
			publish(party.alice, CLIENT_IDS.alice, presence('alice', on('rec-shared')))
			await vi.waitFor(() => expect(armed).toBe(false))
			// Meanwhile rec-shared moves out of Carol's grant.
			expect(
				(
					await ctx.apply({
						collection: 'docs',
						type: 'update',
						recordId: 'rec-shared',
						data: { spaceId: 'doc:alice-bob-private' },
					})
				).ok,
			).toBe(true)
			held.open()
			await vi.waitFor(() =>
				expect(shown(party.bob, CLIENT_IDS.alice)?.cursor?.recordId).toBe('rec-shared'),
			)
			await tick(100)
			// Carol never saw Alice on a record she can no longer read.
			const leaked = seen(party.carol, CLIENT_IDS.alice, carolMark).filter(
				(state) => state?.cursor?.recordId === 'rec-shared',
			)
			expect(leaked).toEqual([])
		} finally {
			held.open()
			reads.mockRestore()
		}
	})

	test('writes to a record many cursors name cost a bounded number of reads, not one per cursor per write', async () => {
		const ctx = harness.server.getKoraContext()
		const write = async (i: number): Promise<void> => {
			const result = await ctx.apply({
				collection: 'docs',
				type: 'update',
				recordId: 'rec-shared',
				data: { title: `t${i}` },
			})
			expect(result.ok).toBe(true)
		}
		const reads = vi.spyOn(harness.store, 'queryCollection')
		for (let i = 0; i < 20; i++) await write(i)
		await tick(100)
		const baseline = readsOf(reads.mock.calls, 'rec-shared')

		for (const [name, client] of Object.entries(party) as Array<[keyof Party, TestClient]>) {
			publish(client, CLIENT_IDS[name], presence(name, on('rec-shared')))
		}
		await vi.waitFor(() => expect(shown(party.alice, CLIENT_IDS.anon)).not.toBeNull())
		await tick()
		reads.mockClear()
		for (let i = 0; i < 20; i++) await write(100 + i)
		await tick(100)
		const withCursors = readsOf(reads.mock.calls, 'rec-shared')
		reads.mockRestore()
		// Four cursors on the record: one coalesced re-read per burst of writes, not
		// four per write.
		expect(withCursors - baseline).toBeLessThanOrEqual(20 + 2)
	})

	test('a narrowed grant ends the session; on reconnect it does not catch up on presence it lost', async () => {
		publish(party.alice, CLIENT_IDS.alice, presence('alice', on('rec-shared')))
		await vi.waitFor(() => expect(shown(party.carol, CLIENT_IDS.alice)).not.toBeNull())
		const before = SPACES.carol ?? []
		SPACES.carol = ['user:carol']
		try {
			const ended = await harness.server.refreshScopes('carol')
			expect(ended).toBe(1)
			const carol2 = await harness.login('carol', 'node-carol')
			publish(carol2, CLIENT_IDS.carol, presence('carol'))
			await tick()
			expect(seen(carol2, CLIENT_IDS.alice)).toEqual([])
			// Alice no longer counts the closed session among those shown her state.
			publish(party.alice, CLIENT_IDS.alice, null)
			await tick()
			expect(seen(carol2, CLIENT_IDS.alice)).toEqual([])
		} finally {
			SPACES.carol = before
		}
	})
})
