/**
 * RT-76 repro (Phase 3 red team round 2, 2026-10-03): the one-time legacy authority
 * scan reads authority stamps out of device-written VALUES.
 *
 * At the first start of beta.13 the server stores record as legacy authoritative ids
 * the node ids of every op id found under an object shaped `{ c: 1, t: <string>,
 * o: <op id> }` anywhere in a stored fold state (`authoritativeStampOpIds` walks the
 * JSON generically). A fold state also holds field values (`"v": value`), so a json
 * value holding an object of that shape (one level down: top-level keys fold per key),
 * written by any device, names any op id it likes:
 * here a victim device's op. The victim's node then becomes a server authority: its
 * writes win `merge('server-authoritative')` fields everywhere, and its own handshake
 * is refused for good (INVALID_NODE_ID). The attacker can name its own op id instead,
 * which turns its past writes into server decisions.
 *
 * Reach: only a database that already holds fold states at its first beta.13 start
 * (written by a pre-release fold build); the repro simulates one by clearing the scan
 * marker. P3.
 *
 * Asserts the CORRECT behaviour (fails at 4d6c8a7): the victim's node is not an authority.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), extra: t.json().optional() } } },
})

function op(nodeId: string, seq: number, partial: Partial<Operation>): Operation {
	return {
		id: `rt76-${nodeId}-${seq}`,
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: `r-${nodeId}`,
		data: {},
		previousData: null,
		timestamp: { wallTime: 1_790_000_000_000 + seq, logical: 0, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	}
}

describe('RT-76: legacy authority scan trusts value-shaped stamps', () => {
	test('a json value naming a device op does not make that device an authority', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt76-'))
		const filename = join(dir, 'server.db')
		try {
			const first = createSqliteServerStore({ filename })
			await first.setSchema(schema)
			const victimOp = op('victim-node', 1, { data: { title: 'mine' } })
			await first.applyRemoteOperation(victimOp)
			await first.applyRemoteOperation(
				op('attacker-node', 1, {
					data: { title: 'x', extra: { note: { c: 1, t: 'anything', o: victimOp.id } } },
				}),
			)
			await first.close()

			// A database whose fold states predate the one-time scan.
			const Database = createRequire(import.meta.url)('better-sqlite3')
			const raw = new Database(filename)
			raw
				.prepare(
					"DELETE FROM kora_server_meta WHERE key IN ('server_legacy_authority_scan_v1', 'server_legacy_authoritative_node_ids')",
				)
				.run()
			raw.close()

			const upgraded = createSqliteServerStore({ filename })
			await upgraded.setSchema(schema)
			expect(upgraded.getAuthoritativeNodeIds()).not.toContain('victim-node')
			await upgraded.close()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
