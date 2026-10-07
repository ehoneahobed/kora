/**
 * F4: a signed-in server whose grant restricts no collection shares every user's data
 * with every other user. beta.13 stopped warning about it, because the built-in
 * provider always returns a claims grant (`{ $claims: { userId } }`) that binds to
 * nothing when the schema declares no sync rule.
 */
import { claimScopes, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { createHarness } from '../repro/rt-fixture'

const unscopedSchema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), ownerId: t.string() } } },
})

const scopedSchema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), ownerId: t.string() } } },
	sync: { notes: { where: { ownerId: 'userId' } } },
})

// What KoraAuthProvider returns without resolveScopes.
const claimsAuth = () =>
	new TokenAuthProvider({
		validate: async (token) => ({ userId: token, scopes: claimScopes({ userId: token }) }),
	})

afterEach(() => {
	vi.restoreAllMocks()
})

function warnings(spy: ReturnType<typeof vi.spyOn>): string[] {
	return spy.mock.calls.map((call: unknown[]) => String(call[0]))
}

describe('F4: multi-tenant without scopes', () => {
	test('a claims grant that binds to no collection warns once', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const harness = await createHarness(unscopedSchema, claimsAuth())
		await harness.login('ann', 'ann-node')
		await harness.login('ben', 'ben-node')
		const shared = warnings(warn).filter((w) => w.includes("every other user's data"))
		expect(shared).toHaveLength(1)
	})

	test('a schema sync rule that binds the claim does not warn', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const harness = await createHarness(scopedSchema, claimsAuth())
		await harness.login('ann', 'ann-node')
		expect(warnings(warn).filter((w) => w.includes("every other user's data"))).toEqual([])
	})

	test('unscopedSharing: "allow" silences it, "refuse" refuses the session', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const allowed = await createHarness(unscopedSchema, claimsAuth(), {
			unscopedSharing: 'allow',
		})
		await allowed.login('ann', 'ann-node')
		expect(warnings(warn).filter((w) => w.includes("every other user's data"))).toEqual([])

		const refusing = await createHarness(unscopedSchema, claimsAuth(), {
			unscopedSharing: 'refuse',
		})
		const ann = await refusing.login('ann', 'ann-node')
		const error = ann.messages.find((m) => m.type === 'error')
		expect(error?.type === 'error' ? error.code : null).toBe('UNSCOPED_SHARING_REFUSED')
	})
})
