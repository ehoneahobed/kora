/**
 * RT-90 repro (Phase 4 beta.12 compatibility, 2026-10-03): a database a beta.12 (or
 * older) client synced registers its node as ACCEPTED, so after the server upgrade its
 * unsynced writes are held forever.
 *
 * The local node registry (RT-38) seeds a node of a database from an earlier release as
 * accepted when it has sync history, assuming the server that accepted it recorded a
 * claim for its user. beta.12 servers recorded no claims. After a beta.12 server
 * database is upgraded, an authenticated device's node has history and no claim, so its
 * handshake is refused `NODE_ID_CLAIMED` (RT-5). Because the node counts as accepted,
 * the client treats the refusal as "another user owns this node" (RT-38): it switches
 * to a fresh node and HOLDS the old node's unsynced writes as `other-user`, which can
 * be neither assigned nor discarded. Writes the user made offline before upgrading never
 * reach the server.
 *
 * Found with the real beta.12 build (tag v1.0.0-beta.12):
 * `scripts/remediation/compat-beta12.mjs <b12> upgrade/server-db/sqlite/token`
 * (the upgraded device's offline write never arrives).
 *
 * Asserts the CORRECT behaviour (fails before the fix): only evidence of a claims-aware
 * server (a node token, or this release's acknowledged-prefix record) makes a legacy
 * node accepted. A node that only a beta.12 server ever accepted is not, so a refusal
 * re-authors its never-sent writes under a fresh node and uploads them (RT-21).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'
import { listLocalNodes } from '../../src/sync/local-sync-records'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
}) as unknown as SchemaDefinition

const dir = mkdtempSync(join(tmpdir(), 'rt-90-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('RT-90: a node only a beta.12 server accepted is not a claimed node', () => {
	test('a synced beta.12 database registers its node as not accepted', async () => {
		const file = join(dir, 'beta12.db')
		// What a synced beta.12 database holds in _kora_meta (no local node registry).
		const raw = new BetterSqlite3Adapter(file)
		await raw.open(schema)
		await raw.execute("INSERT INTO _kora_meta (key, value) VALUES ('node_id', 'beta12-node')")
		await raw.execute("INSERT INTO _kora_meta (key, value) VALUES ('delivery_watermark', '7')")
		await raw.execute(
			"INSERT INTO _kora_meta (key, value) VALUES ('last_acked_server_vector', '{\"beta12-node\":5}')",
		)
		await raw.close()

		const upgraded = new Store({ schema, adapter: new BetterSqlite3Adapter(file) })
		await upgraded.open()
		expect(upgraded.getNodeId()).toBe('beta12-node')
		const adapter = (upgraded as unknown as { adapter: BetterSqlite3Adapter }).adapter
		const node = (await listLocalNodes(adapter)).find((n) => n.nodeId === 'beta12-node')
		expect(node?.accepted).toBe(false)
		await upgraded.close()
	})
})
