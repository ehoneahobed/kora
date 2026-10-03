/**
 * RT-91 repro (Phase 4 beta.12 compatibility, 2026-10-03): after a beta.12 server
 * database is upgraded, every anonymous device that synced before is refused, even
 * with `allowLegacyAnonymousClaims` (default true in this release).
 *
 * beta.12 recorded no node claims. Its anonymous devices (MixedAuthProvider) therefore
 * own a node id with operation history and no claim row. The RT-21 legacy path only
 * adopts nodes held by the pre-release shared owner (`kora:anonymous`) or by an expired
 * provisional claim (claims of the never-released Phase 1 build); a beta.12 node has
 * neither, so the handshake is refused `NODE_ID_CLAIMED`. beta.12 clients cannot rotate
 * their node id: they reconnect forever and their unsynced writes never sync.
 *
 * Found with the real beta.12 build (tag v1.0.0-beta.12):
 * `scripts/remediation/compat-beta12.mjs <b12> upgrade/server-db/sqlite/anonymous`.
 *
 * Asserts the CORRECT behaviour (fails before the fix): with legacy anonymous claims
 * allowed, such a node is re-issued to the anonymous device (as a provisional claim,
 * like every legacy anonymous claim); without them it is refused; a signed-in user
 * still cannot take it (RT-5).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { MixedAuthProvider } from '../../src/auth/mixed-auth-provider'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createHarness, makeOp } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { responses: { fields: { answer: t.string() } } },
})

const auth = new MixedAuthProvider({
	primary: new TokenAuthProvider({
		validate: async (token) => (token === 'alice-token' ? { userId: 'alice' } : null),
	}),
	anonymousScopes: { responses: {} },
})

function accepted(messages: SyncMessage[]): boolean {
	return messages.some((m) => m.type === 'handshake-response' && m.accepted)
}

/** A store holding history a beta.12 server wrote for `nodeId` (no claim row). */
async function beta12History(nodeId: string): Promise<MemoryServerStore> {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	await store.applyRemoteOperation(
		makeOp(nodeId, 1, { collection: 'responses', recordId: 'r-1', data: { answer: 'old' } }),
	)
	return store
}

describe('RT-91: anonymous beta.12 devices after a server database upgrade', () => {
	test('a node with pre-claims history is re-issued to an anonymous device', async () => {
		const store = await beta12History('kiosk-node')
		const harness = await createHarness(schema, auth, {}, store)
		const kiosk = await harness.login('', 'kiosk-node')
		expect(accepted(kiosk.messages)).toBe(true)
		// A token is issued (provisional claim), so an upgraded client can confirm it.
		const response = kiosk.messages.find((m) => m.type === 'handshake-response') as
			| { nodeToken?: string }
			| undefined
		expect(typeof response?.nodeToken).toBe('string')
		await harness.server.stop()
	})

	test('without legacy anonymous claims the node is refused', async () => {
		const store = await beta12History('kiosk-node')
		const harness = await createHarness(schema, auth, { allowLegacyAnonymousClaims: false }, store)
		const kiosk = await harness.login('', 'kiosk-node')
		expect(accepted(kiosk.messages)).toBe(false)
		await harness.server.stop()
	})

	test('a signed-in user still cannot take a node with pre-claims history (RT-5)', async () => {
		const store = await beta12History('kiosk-node')
		const harness = await createHarness(schema, auth, {}, store)
		const alice = await harness.login('alice-token', 'kiosk-node')
		expect(accepted(alice.messages)).toBe(false)
		await harness.server.stop()
	})
})
