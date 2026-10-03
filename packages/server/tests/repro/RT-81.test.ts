/**
 * RT-81 repro (Phase 3 red team round 3, 2026-10-03): the authority union (RT-75 fix)
 * has no revocation, and the server forgets what it once advertised.
 *
 * Devices keep the UNION of every explicit authoritative id a handshake ever listed
 * (store `setAuthoritativeNodeIds`, sync engine), for good. The server refuses a device
 * handshake only for ids it CURRENTLY lists (`isServerAuthorNodeId`), and the claim rule
 * lets a device take an id with no stored history. So once an operator removes a
 * configured extra authority (to revoke it, or on one instance of several), any device
 * may hand-shake with that id; its `merge('server-authoritative')` writes then win on
 * every device that learned the id, and are ordinary writes on the server: permanent
 * divergence, and authority on devices.
 *
 * Asserts the CORRECT behaviour (fails at 97981a7): an id the deployment once advertised
 * as authoritative is never accepted as a device node id.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import type { MemoryServerStore } from '../../src/store/memory-server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'
import { createHarness } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		items: { fields: { title: t.string(), status: t.string().merge('server-authoritative') } },
	},
})

type HandshakeResponse = SyncMessage & { accepted?: boolean; authoritativeNodeIds?: string[] }

describe('RT-81: a revoked authoritative id becomes a device id', () => {
	test('an id advertised before a config change is still refused at handshake', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-rt81-'))
		const filename = join(dir, 'server.db')
		try {
			const first = await createHarness(
				schema,
				null,
				{},
				createSqliteServerStore({
					filename,
					authoritativeNodeIds: ['admin-svc'],
				}) as unknown as MemoryServerStore,
			)
			const device = await first.login('t', 'device-a', { protocolVersion: 2 })
			const response = device.messages.find((m) => m.type === 'handshake-response') as
				| HandshakeResponse
				| undefined
			// Devices learn (and keep for good) the explicit authority.
			expect(response?.authoritativeNodeIds).toContain('admin-svc')
			await first.server.stop()

			// The operator removes the extra (revocation); same database.
			const second = await createHarness(
				schema,
				null,
				{},
				createSqliteServerStore({ filename }) as unknown as MemoryServerStore,
			)
			const forger = await second.login('t', 'admin-svc', { protocolVersion: 2 })
			const answer = forger.messages.find(
				(m) => m.type === 'handshake-response' || m.type === 'error',
			) as HandshakeResponse | undefined
			// Correct: refused (fails: accepted, and its writes are authoritative on devices).
			expect(answer?.type === 'error' || answer?.accepted === false).toBe(true)
			await second.server.stop()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
