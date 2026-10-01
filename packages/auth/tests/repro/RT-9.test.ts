/**
 * RT-9 repro (red team, 2026-10-01): refresh rotation checks revocation, then consumes
 * the parent, then signs successors with `iat = consumedAt`. A device revocation that
 * lands between the check and the consume is older than the successors, so the
 * successors survive it. Deterministic: the revocation is injected inside `consume`.
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
	type ConsumeResult,
	InMemoryTokenRevocationStore,
	TokenManager,
} from '../../src/tokens/token-manager'

class RevokeDuringConsumeStore extends InMemoryTokenRevocationStore {
	armed: { kind: 'device' | 'user'; id: string } | null = null

	override async consume(jti: string, expiresAt: number): Promise<ConsumeResult> {
		const armed = this.armed
		if (armed) {
			this.armed = null
			// The revocation lands after rotate()'s revocation check...
			if (armed.kind === 'device') await this.revokeAllForDevice(armed.id, Date.now())
			else await this.revokeAllForUser(armed.id, Date.now())
			// ...and the consume happens a moment later.
			vi.setSystemTime(Date.now() + 5)
		}
		return super.consume(jti, expiresAt)
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('RT-9: refresh racing a revocation', () => {
	for (const kind of ['device', 'user'] as const) {
		test(`a ${kind} revocation during rotation also revokes the successors`, async () => {
			vi.useFakeTimers({ toFake: ['Date'] })
			vi.setSystemTime(1_800_000_000_000)
			const store = new RevokeDuringConsumeStore()
			const manager = new TokenManager({
				secret: TokenManager.generateSecret(),
				revocationStore: store,
			})
			const tokens = manager.issueTokens('user-1', 'device-1')
			vi.setSystemTime(Date.now() + 1000)
			store.armed = { kind, id: kind === 'device' ? 'device-1' : 'user-1' }
			const result = await manager.rotateRefreshToken(tokens.refreshToken)
			if (result.ok) {
				expect(await manager.validateTokenWithRevocation(result.tokens.accessToken)).toBeNull()
				expect(await manager.validateTokenWithRevocation(result.tokens.refreshToken)).toBeNull()
				expect((await manager.rotateRefreshToken(result.tokens.refreshToken)).ok).toBe(false)
			}
			expect(result.ok).toBe(false)
		})
	}
})
