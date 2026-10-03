/**
 * RT-71 repro (Phase 3 red team round 2, 2026-10-03): the strict version-1 id check
 * (RT-64 fix) refuses legitimate writes of beta.13 (protocol 1) clients.
 *
 * A beta.13 client hashes an operation with `canonicalize`, which writes an object
 * member whose value is `undefined` as `"key":null`. Its update path keeps such
 * members (`validateRecord` copies `undefined` for updates, e.g.
 * `update(id, { assignee: undefined })`), and object fields keep nested `undefined`
 * members (`{ a: 1, b: undefined }`). The op log and the wire are JSON, so the member
 * is gone by the time the server sees the operation; the server recomputes the
 * version-1 hash without it, the id does not match, and the write is refused
 * INVALID_OPERATION_ID (terminal). The beta.13 client keeps the value locally, so it
 * diverges for good; no peer ever sees the write.
 *
 * Confirmed end to end against the real beta.13 build (33bca46) with
 * `scripts/remediation/rt-legacy-id-probe.mjs`: 3 of 4 ordinary write shapes refused.
 *
 * Asserts the CORRECT behaviour (fails at 4d6c8a7): the write is stored.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { withContentId } from '../fixtures/content-id'
import { batch, createHarness, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				assignee: t.string().optional(),
				meta: t.object({ a: t.number().optional(), b: t.string().optional() }).optional(),
			},
		},
	},
})

/** What a beta.13 client uploads: id over the in-memory data, data after a JSON round trip. */
function legacyOp(nodeId: string, seq: number, partial: Partial<Operation>): Operation {
	const built = withContentId({
		id: '',
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: 'n-1',
		data: {},
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: seq, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	} as Operation)
	return JSON.parse(JSON.stringify(built)) as Operation
}

describe('RT-71: strict version-1 verification refuses legitimate beta.13 writes', () => {
	test.each([
		['insert with a nested undefined member', { title: 'x', meta: { a: 1, b: undefined } }],
		['update clearing a field with undefined', { title: 'y', assignee: undefined }],
	])('%s is stored', async (_name, data) => {
		const { store, server, login } = await createHarness(schema, null)
		const legacy = await login('t', 'legacy-node')
		const insert = legacyOp('legacy-node', 1, { data: { title: 'x', assignee: 'bob' } })
		const write =
			'assignee' in data
				? legacyOp('legacy-node', 2, {
						type: 'update',
						data,
						previousData: { title: 'x', assignee: 'bob' },
						causalDeps: [insert.id],
					})
				: legacyOp('legacy-node', 2, { recordId: 'n-2', data })
		legacy.send(batch([insert, write]))
		await tick(100)
		const refused = legacy.messages.filter(
			(m) => m.type === 'operation-rejected' && m.operationId === write.id,
		)
		expect(refused).toEqual([])
		expect(store.getAllOperations().some((o) => o.id === write.id)).toBe(true)
		await server.stop()
	})
})
