/**
 * RT-88 repro (Phase 4 beta.12 compatibility, 2026-10-03): a `Date` inside a `t.json()`
 * value of a beta.12 (and older) write makes its version-1 id unverifiable.
 *
 * beta.12 accepted any JSON-serializable json value, a `Date` included. Its version-1
 * hash (`canonicalize`) walks `Object.keys`, so a `Date` hashes as `{}`; the op log and
 * the wire are JSON, so the value arrives as its `toISOString()` string. The server's
 * version-1 check rebuilt `undefined` members and binary forms (RT-71) but not this one:
 * - from a protocol-1 session (a beta.12 device) the write is stored unverified, with the
 *   warning `session.unverified_legacy_operation` (RT-71 fallback);
 * - from a protocol-2 session (the same device after upgrading its database, uploading
 *   a write it made offline under beta.12) it is refused `INVALID_OPERATION_ID`,
 *   terminally, and the write is undone on its author.
 *
 * Found with the real beta.12 build (tag v1.0.0-beta.12):
 * `scripts/remediation/compat-beta12.mjs <b12> upgrade/client-db/offline`.
 *
 * Asserts the CORRECT behaviour (fails before the fix): the id matches the beta.12 hash
 * form, so the upgraded device's write is stored as written.
 */
import { computeOperationId, defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { batch, createHarness, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), extra: t.json().optional() } } },
})

/** What beta.12 uploads: the id over the in-memory value (a Date), the data as JSON. */
async function beta12Op(nodeId: string, data: Record<string, unknown>): Promise<Operation> {
	const built: Operation = {
		id: '',
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: 'n-1',
		data,
		previousData: null,
		timestamp: { wallTime: 1_790_000_000_000, logical: 0, nodeId },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
	const id = await computeOperationId(built, 1)
	return JSON.parse(JSON.stringify({ ...built, id })) as Operation
}

const shapes: Array<[string, Record<string, unknown>]> = [
	['a Date member', { title: 'x', extra: { when: new Date(1_700_000_000_000), k: 1 } }],
	['a top-level Date', { title: 'x', extra: new Date(1_700_000_000_000) }],
	[
		'a Date next to a genuine ISO string',
		{
			title: '2023-11-14T22:13:20.000Z',
			extra: { a: new Date(0), b: ['1970-01-01T00:00:00.000Z'] },
		},
	],
]

describe('RT-88: beta.12 hashed a Date inside a json value as {}', () => {
	test.each(shapes)('%s: an upgraded device (protocol 2) uploads it', async (_name, data) => {
		const { store, server, login } = await createHarness(schema, null)
		const device = await login('t', 'upgraded-node', { protocolVersion: 2 })
		const op = await beta12Op('upgraded-node', data)
		device.send(batch([op]))
		await tick(100)
		const refused = device.messages.filter(
			(m) => m.type === 'operation-rejected' && m.operationId === op.id,
		)
		expect(refused).toEqual([])
		const all = (await store.getOperationsAfterDelivery(0, 10_000)).map((d) => d.operation)
		expect(all.find((o) => o.id === op.id)?.data).toEqual(op.data)
		await server.stop()
	})
})
