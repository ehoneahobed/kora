/**
 * F17: the `$in` scope predicate limit is a server option (`maxScopePredicateValues`).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createHarness } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { docs: { fields: { spaceId: t.string(), title: t.string() } } },
})

const spaces = (count: number): string[] => Array.from({ length: count }, (_, i) => `space-${i}`)

// Tokens are `<user>:<number of spaces>`.
const auth = new TokenAuthProvider({
	validate: async (token) => {
		const [userId, count] = token.split(':')
		return {
			userId: userId ?? token,
			scopes: { docs: { spaceId: { $in: spaces(Number(count)) } } },
		}
	},
})

function outcome(messages: SyncMessage[]): string {
	const error = messages.find((m) => m.type === 'error')
	if (error?.type === 'error') return error.code
	return messages.some((m) => m.type === 'handshake-response' && m.accepted) ? 'accepted' : 'none'
}

describe('maxScopePredicateValues', () => {
	test('defaults to 100 values', async () => {
		const harness = await createHarness(schema, auth)
		expect(outcome((await harness.login('ann:100', 'ann-node')).messages)).toBe('accepted')
		expect(outcome((await harness.login('ben:101', 'ben-node')).messages)).toBe(
			'SCOPE_PREDICATE_LIMIT',
		)
	})

	test('a configured limit admits larger grants and still refuses beyond it', async () => {
		const harness = await createHarness(schema, auth, {
			maxScopePredicateValues: 2_000,
			sessionRevalidationIntervalMs: 0,
		})
		const ann = await harness.login('ann:2000', 'ann-node')
		expect(outcome(ann.messages)).toBe('accepted')
		expect(outcome((await harness.login('ben:2001', 'ben-node')).messages)).toBe(
			'SCOPE_PREDICATE_LIMIT',
		)
		// Revalidation and presence keys work with the large grant (no limit error).
		expect(await harness.server.revalidateSessions()).toBe(0)
		expect(await harness.server.refreshScopes('ann')).toBe(0)
	})

	test('a record in a large grant is delivered', async () => {
		const harness = await createHarness(schema, auth, { maxScopePredicateValues: 1_500 })
		const result = await harness.server.getKoraContext().apply({
			collection: 'docs',
			type: 'insert',
			recordId: 'doc-last',
			data: { spaceId: 'space-1499', title: 'last space' },
		})
		expect(result.ok).toBe(true)
		const ann = await harness.login('ann:1500', 'ann-node')
		const delivered = ann.messages.flatMap((m) =>
			m.type === 'operation-batch' ? m.operations.map((op) => op.recordId) : [],
		)
		expect(delivered).toContain('doc-last')
	})

	test('refuses an invalid limit', () => {
		const store = new MemoryServerStore('server-1')
		for (const value of [0, -1, 1.5, Number.NaN]) {
			expect(() => new KoraSyncServer({ store, maxScopePredicateValues: value })).toThrow(
				/maxScopePredicateValues/,
			)
		}
	})
})
