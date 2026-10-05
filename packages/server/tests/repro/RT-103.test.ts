/**
 * RT-103 repro (final RC red team, transforms at fold time): removing an OLD transform
 * from `operationTransforms` silently erases every operation of that schema version from
 * the server's records. The transform list is part of the fold plan fingerprint, so the
 * next start re-folds every record; `operationSchemaView` returns null for an operation
 * with no path to the current version, and `mergeOp` folds a null view as nothing. A
 * record inserted under v1 disappears from the server (and its fields written under v1
 * revert), with no error, log line or quarantine. Removing the WHOLE list instead keeps
 * the same operations (they fold as written), so the outcome depends on which transforms
 * happen to remain. Retiring v1->v2 once every client runs v2+ is the natural thing to do,
 * but the operation log is append-only, so v1 operations exist forever.
 * Devices refuse/park an operation they cannot read; the server's fold drops it.
 *
 * Asserts CORRECT behaviour: a start whose transforms cannot read stored operations
 * refuses (or keeps those records), never silently drops them.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Operation, OperationTransform } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'

const schema = defineSchema({
	version: 3,
	collections: { notes: { fields: { title: t.string(), body: t.string().optional() } } },
})

// v1 called the field `name`; v2 renamed it to `title`; v3 added `body`.
const v1ToV2: OperationTransform = {
	fromVersion: 1,
	toVersion: 2,
	transform: (op) => {
		if (!op.data || !('name' in op.data)) return { ...op, schemaVersion: 2 }
		const { name, ...rest } = op.data
		return { ...op, data: { ...rest, title: name }, schemaVersion: 2 }
	},
}
const v2ToV3: OperationTransform = {
	fromVersion: 2,
	toVersion: 3,
	transform: (op) => ({ ...op, schemaVersion: 3 }),
}

function v1Insert(): Operation {
	return {
		id: 'rt103-1',
		nodeId: 'device-a',
		type: 'insert',
		collection: 'notes',
		recordId: 'r1',
		data: { name: 'written under v1' },
		previousData: null,
		timestamp: { wallTime: 1_700_000_000_000, logical: 0, nodeId: 'device-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('RT-103: retiring an old transform erases that version from server records', () => {
	test('a v1 record survives a restart that registers only v2->v3', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt103-'))
		const filename = join(dir, 'server.db')
		try {
			const first = createSqliteServerStore({ filename })
			await first.setSchema(schema, { operationTransforms: [v1ToV2, v2ToV3] })
			await first.applyRemoteOperation(v1Insert())
			expect(await first.findRecord('notes', 'r1')).toMatchObject({ title: 'written under v1' })
			await first.close()

			// Next deploy: every client runs v2 or later, so v1->v2 is retired.
			const next = createSqliteServerStore({ filename })
			let failure: unknown = null
			try {
				await next.setSchema(schema, { operationTransforms: [v2ToV3] })
			} catch (error) {
				failure = error
			}
			if (failure === null) {
				// Accepted start: the record must still be there.
				expect(await next.findRecord('notes', 'r1')).toMatchObject({ title: 'written under v1' })
			}
			await next.close()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
