import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeJwt } from './jwt'
import { InMemoryTokenRevocationStore, TokenManager } from './token-manager'

const SECRET = 'rotation-test-secret-at-least-thirty-two-chars'

function manager(store = new InMemoryTokenRevocationStore(), graceMs?: number) {
	return {
		store,
		tm: new TokenManager({ secret: SECRET, revocationStore: store, refreshReuseGraceMs: graceMs }),
	}
}

describe('TokenManager rotation (AUTH-6, NEW-AUTH-1, NEW-AUTH-3)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-10-01T08:00:00Z'))
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('tokens of one sign-in share a family, and rotation keeps it', async () => {
		const { tm } = manager()
		const issued = tm.issueTokens('u1', 'd1')
		const fam = decodeJwt(issued.refreshToken)?.fam
		expect(typeof fam).toBe('string')
		expect(decodeJwt(issued.accessToken)?.fam).toBe(fam)
		const next = await tm.rotateRefreshToken(issued.refreshToken)
		expect(next.ok).toBe(true)
		if (next.ok) {
			expect(decodeJwt(next.tokens.refreshToken)?.fam).toBe(fam)
			expect(decodeJwt(next.tokens.accessToken)?.fam).toBe(fam)
		}
	})

	it('a grace replay returns byte-identical successors exactly once', async () => {
		const { tm } = manager()
		const issued = tm.issueTokens('u1', 'd1')
		const first = await tm.rotateRefreshToken(issued.refreshToken)
		vi.advanceTimersByTime(5_000)
		const replay = await tm.rotateRefreshToken(issued.refreshToken)
		expect(first.ok && replay.ok).toBe(true)
		if (first.ok && replay.ok) {
			expect(replay.tokens).toEqual(first.tokens)
			expect(replay.replayed).toBe(true)
		}
		const third = await tm.rotateRefreshToken(issued.refreshToken)
		expect(third).toEqual({ ok: false, reason: 'reused' })
		// The reuse revoked the family, so the successor is dead too.
		if (first.ok) {
			expect(await tm.validateTokenWithRevocation(first.tokens.accessToken)).toBeNull()
		}
	})

	it('no grace after the window or after the successor was used', async () => {
		const { tm } = manager()
		const a = tm.issueTokens('u1', 'd1')
		await tm.rotateRefreshToken(a.refreshToken)
		vi.advanceTimersByTime(31_000)
		expect(await tm.rotateRefreshToken(a.refreshToken)).toEqual({ ok: false, reason: 'reused' })

		const b = tm.issueTokens('u1', 'd1')
		const bNext = await tm.rotateRefreshToken(b.refreshToken)
		expect(bNext.ok).toBe(true)
		if (bNext.ok) await tm.rotateRefreshToken(bNext.tokens.refreshToken)
		expect(await tm.rotateRefreshToken(b.refreshToken)).toEqual({ ok: false, reason: 'reused' })
	})

	it('grace can be disabled', async () => {
		const { tm } = manager(new InMemoryTokenRevocationStore(), 0)
		const a = tm.issueTokens('u1', 'd1')
		await tm.rotateRefreshToken(a.refreshToken)
		expect(await tm.rotateRefreshToken(a.refreshToken)).toEqual({ ok: false, reason: 'reused' })
	})

	it('a signed-out (revoked) refresh token never gets a grace successor', async () => {
		const { tm } = manager()
		const a = tm.issueTokens('u1', 'd1')
		const payload = tm.validateToken(a.refreshToken)
		if (!payload) throw new Error('invalid token')
		await tm.rotateRefreshToken(a.refreshToken)
		await tm.revokeToken(payload.jti, payload.exp)
		expect(await tm.rotateRefreshToken(a.refreshToken)).toEqual({ ok: false, reason: 'revoked' })
	})

	it('for every N, N concurrent rotations of one token mint exactly one successor', async () => {
		for (let n = 2; n <= 12; n++) {
			const { tm } = manager()
			const a = tm.issueTokens('u1', 'd1')
			const results = await Promise.all(
				Array.from({ length: n }, () => tm.rotateRefreshToken(a.refreshToken)),
			)
			expect(results.filter((r) => r.ok)).toHaveLength(1)
			for (const r of results) {
				if (!r.ok) expect(r.reason).toBe('in_progress')
			}
		}
	})

	it('a device cut-off rejects earlier tokens but not a later sign-in on the device', async () => {
		const { tm } = manager()
		const before = tm.issueTokens('u1', 'd1')
		vi.advanceTimersByTime(10)
		await tm.revokeDeviceTokens('d1')
		vi.advanceTimersByTime(10)
		const after = tm.issueTokens('u1', 'd1')
		expect(await tm.validateTokenWithRevocation(before.accessToken)).toBeNull()
		expect(await tm.rotateRefreshToken(before.refreshToken)).toEqual({
			ok: false,
			reason: 'device_revoked',
		})
		expect(await tm.validateTokenWithRevocation(after.accessToken)).not.toBeNull()
	})

	it('revokeAllForUser rejects every earlier token of the user on every device', async () => {
		const { tm } = manager()
		const phone = tm.issueTokens('u1', 'phone')
		const laptop = tm.issueTokens('u1', 'laptop')
		const other = tm.issueTokens('u2', 'phone-2')
		vi.advanceTimersByTime(10)
		await tm.revokeAllForUser('u1')
		vi.advanceTimersByTime(10)
		expect(await tm.validateTokenWithRevocation(phone.accessToken)).toBeNull()
		expect(await tm.validateTokenWithRevocation(laptop.accessToken)).toBeNull()
		expect(await tm.rotateRefreshToken(laptop.refreshToken)).toEqual({
			ok: false,
			reason: 'user_revoked',
		})
		expect(await tm.validateTokenWithRevocation(other.accessToken)).not.toBeNull()
		const fresh = tm.issueTokens('u1', 'phone')
		expect(await tm.validateTokenWithRevocation(fresh.accessToken)).not.toBeNull()
	})

	it('pre-beta.13 tokens without iatMs are covered by a cut-off in the same second', async () => {
		const { tm, store } = manager()
		const a = tm.issueTokens('u1', 'd1')
		const payload = tm.validateToken(a.accessToken)
		if (!payload) throw new Error('invalid token')
		// Same second, but strictly after the issue instant.
		await store.revokeAllForDevice('d1', payload.iat * 1000 + 1)
		const legacy = { ...payload, iatMs: undefined }
		expect(await tm.revocationReason(legacy)).toBe('device_revoked')
	})
})
