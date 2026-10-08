/**
 * KoraSyncServer.refreshScopes / ProductionServer.refreshScopes and revalidateSessions.
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createHarness, tick } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { docs: { fields: { spaceId: t.string(), title: t.string() } } },
})

function errorCodes(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) => (m.type === 'error' ? [m.code] : []))
}

describe('refreshScopes', () => {
	test("ends only the named user's sessions whose grant changed", async () => {
		const spaces: Record<string, string[]> = { ann: ['a'], ben: ['b'] }
		const auth = new TokenAuthProvider({
			validate: async (token) => ({
				userId: token,
				scopes: { docs: { spaceId: { $in: [...(spaces[token] ?? [])] } } },
			}),
		})
		const harness = await createHarness(schema, auth, { sessionRevalidationIntervalMs: 0 })
		const ann1 = await harness.login('ann', 'ann-1')
		const ann2 = await harness.login('ann', 'ann-2')
		const ben = await harness.login('ben', 'ben-1')

		expect(await harness.server.refreshScopes('ann')).toBe(0)
		spaces.ann = ['a', 'shared']
		spaces.ben = ['b', 'shared']
		expect(await harness.server.refreshScopes('ann')).toBe(2)
		await tick()
		expect(errorCodes(ann1.messages)).toEqual(['SCOPE_CHANGED'])
		expect(errorCodes(ann2.messages)).toEqual(['SCOPE_CHANGED'])
		// Ben's grant changed too, but only the app's call for him applies it.
		expect(errorCodes(ben.messages)).toEqual([])
		expect(await harness.server.refreshScopes('nobody')).toBe(0)
		await expect(harness.server.refreshScopes('')).rejects.toMatchObject({
			code: 'INVALID_REFRESH_SCOPES_USER',
		})
	})

	test('a handshake that resolved its grant before the change re-checks once established', async () => {
		let spaces = ['a']
		const release: { auth: () => void } = { auth: () => {} }
		let gate: Promise<void> | null = null
		const auth = new TokenAuthProvider({
			validate: async (token) => {
				// The grant is read first, then the provider is slow (a remote call).
				const grant = [...spaces]
				if (gate) await gate
				return { userId: token, scopes: { docs: { spaceId: { $in: grant } } } }
			},
		})
		const harness = await createHarness(schema, auth, { sessionRevalidationIntervalMs: 0 })
		gate = new Promise<void>((resolve) => {
			release.auth = resolve
		})
		const ann = harness.connect()
		ann.send({
			type: 'handshake',
			messageId: 'hs-ann',
			nodeId: 'ann-node',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'ann',
		} as SyncMessage)
		await tick()

		// The membership changes while the handshake is still authenticating.
		spaces = []
		gate = null
		expect(await harness.server.refreshScopes('ann')).toBe(0)
		release.auth()

		await vi.waitFor(() => expect(errorCodes(ann.messages)).toEqual(['SCOPE_CHANGED']))
		expect(ann.messages.some((m) => m.type === 'handshake-response' && m.accepted)).toBe(true)
	})
})

describe('ProductionServer session controls', () => {
	test('exposes refreshScopes and revalidateSessions', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		const server = createProductionServer({
			store,
			port: 0,
			syncOptions: {
				auth: new TokenAuthProvider({ validate: async (token) => ({ userId: token }) }),
			},
		})
		expect(await server.refreshScopes('ann')).toBe(0)
		expect(await server.revalidateSessions()).toBe(0)
		await server.stop()
	})
})
