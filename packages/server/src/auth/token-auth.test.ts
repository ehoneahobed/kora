import { describe, expect, test, vi } from 'vitest'
import { NoAuthProvider } from './no-auth'
import { TokenAuthProvider } from './token-auth'

describe('NoAuthProvider', () => {
	test('always returns anonymous auth context', async () => {
		const provider = new NoAuthProvider()

		const result = await provider.authenticate('any-token')
		expect(result).toEqual({ userId: 'anonymous' })

		const result2 = await provider.authenticate('')
		expect(result2).toEqual({ userId: 'anonymous' })
	})
})

describe('TokenAuthProvider', () => {
	test('delegates to validate function', async () => {
		const validate = vi.fn().mockResolvedValue({ userId: 'user-1', metadata: { role: 'admin' } })
		const provider = new TokenAuthProvider({ validate })

		const result = await provider.authenticate('valid-token')

		expect(validate).toHaveBeenCalledWith('valid-token')
		expect(result).toEqual({ userId: 'user-1', metadata: { role: 'admin' } })
	})

	test('returns null when validate returns null', async () => {
		const validate = vi.fn().mockResolvedValue(null)
		const provider = new TokenAuthProvider({ validate })

		const result = await provider.authenticate('bad-token')

		expect(validate).toHaveBeenCalledWith('bad-token')
		expect(result).toBeNull()
	})
})
