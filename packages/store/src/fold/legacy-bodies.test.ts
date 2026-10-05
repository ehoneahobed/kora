import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeOperationId, defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { title: t.string(), assignee: t.string().optional() } },
	},
}) as unknown as SchemaDefinition

const dir = mkdtempSync(join(tmpdir(), 'legacy-bodies-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A beta.12 (or older) peer's `update(id, { assignee: undefined, title })`, as its JSON log holds it. */
async function peerClear(recordId: string, proven: boolean): Promise<Operation> {
	const timestamp = { wallTime: Date.now() + 1000, logical: 0, nodeId: 'peer' }
	const base = {
		nodeId: 'peer',
		type: 'update' as const,
		collection: 'notes',
		recordId,
		previousData: { title: 'x', assignee: 'bob' },
		timestamp,
		sequenceNumber: proven ? 1 : 2,
		causalDeps: [],
		schemaVersion: 1,
	}
	// The id covers the clear (beta.12 hashed `undefined` as null) only for a genuine body.
	const id = await computeOperationId(
		{ ...base, data: proven ? { title: 'y', assignee: null } : { title: 'z', other: 1 } },
		1,
	)
	return { ...base, id, data: { title: proven ? 'y' : 'z' } }
}

describe('canonicalizeLegacyLogBodies (RT-83, RT-85): the beta.12 clear made explicit once', () => {
	test('own beta.12 clears and proven peer clears are written into the log; others are not', async () => {
		const file = join(dir, 'app.db')
		const legacy = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(file),
			nodeId: 'dev',
			materialization: 'legacy',
		})
		await legacy.open()
		const notes = legacy.collection('notes')
		const own = String((await notes.insert({ title: 'x', assignee: 'bob' })).id)
		const proven = String((await notes.insert({ title: 'x', assignee: 'bob' })).id)
		const unproven = String((await notes.insert({ title: 'x', assignee: 'bob' })).id)
		await notes.update(own, { assignee: null, title: 'y' })
		await legacy.applyRemoteOperation(await peerClear(proven, true))
		await legacy.applyRemoteOperation(await peerClear(unproven, false))
		const adapter = (legacy as unknown as { adapter: BetterSqlite3Adapter }).adapter
		// The own update as beta.12 logged it: the member is gone, no hash version.
		await adapter.execute(
			`UPDATE _kora_ops_notes SET data = ? WHERE type = 'update' AND node_id = 'dev'`,
			[JSON.stringify({ title: 'y' })],
		)
		await legacy.close()

		const upgraded = new Store({ schema, adapter: new BetterSqlite3Adapter(file), nodeId: 'dev' })
		await upgraded.open()
		try {
			const read = (id: string) => upgraded.collection('notes').findById(id)
			expect(await read(own)).toMatchObject({ title: 'y', assignee: null })
			expect(await read(proven)).toMatchObject({ title: 'y', assignee: null })
			// Not proven (as a rewritten copy would be): folded as written.
			expect(await read(unproven)).toMatchObject({ title: 'z', assignee: 'bob' })
			const logged = await upgraded.getOperationsForRecord('notes', proven)
			expect(logged.find((op) => op.nodeId === 'peer')?.data).toEqual({
				title: 'y',
				assignee: null,
			})
		} finally {
			await upgraded.close()
		}
		// Once per database: a second open rewrites nothing and changes nothing.
		const again = new Store({ schema, adapter: new BetterSqlite3Adapter(file), nodeId: 'dev' })
		await again.open()
		expect(await again.collection('notes').findById(own)).toMatchObject({ assignee: null })
		await again.close()
	})
})
