/**
 * RT-8 repro (red team, 2026-10-01): a grant whose predicate value is `undefined` or
 * `null` (for example a failed org lookup) matches every record lacking that field,
 * instead of failing closed. Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { resolveSessionScopes } from '../../src/scopes/resolve-session-scopes'
import { normalizeScopeMap } from '../../src/scopes/server-scope-filter'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createHarness, deliveredOpIds, makeOp } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), orgId: t.string().optional() } } },
})

describe('RT-8: undefined/null scope predicate values fail open', () => {
	for (const bad of [undefined, null]) {
		test(`a session granted { orgId: ${String(bad)} } is refused and receives nothing`, async () => {
			const store = new MemoryServerStore('server-1')
			await store.setSchema(schema)
			const orphan = makeOp('seed-node', 1, { recordId: 'no-org', data: { title: 'internal' } })
			await store.applyRemoteOperation(orphan)
			const auth = new TokenAuthProvider({
				validate: async () => ({ userId: 'u', scopes: { notes: { orgId: bad } } }),
			})
			const harness = await createHarness(schema, auth, {}, store)
			const c = await harness.login('token', 'u-node')
			expect(deliveredOpIds(c.messages)).not.toContain(orphan.id)
			const accepted = c.messages.some(
				(m: SyncMessage) => m.type === 'handshake-response' && m.accepted,
			)
			expect(accepted).toBe(false)
		})

		test(`normalizeScopeMap rejects { orgId: ${String(bad)} }`, () => {
			expect(() => normalizeScopeMap({ notes: { orgId: bad } })).toThrow()
			expect(() => normalizeScopeMap({ notes: { orgId: { $in: ['a', bad] } } })).toThrow()
		})

		test(`resolveSessionScopes rejects a grant with { orgId: ${String(bad)} }`, () => {
			expect(() =>
				resolveSessionScopes(schema, {
					authScopes: { notes: { orgId: bad } },
					authenticated: true,
				}),
			).toThrow()
		})
	}
})
