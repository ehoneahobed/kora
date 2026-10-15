import { afterEach, describe, expect, test, vi } from 'vitest'
import { InMemoryTokenRevocationStore } from '../../tokens/token-manager'
import { hashPassword, verifyPassword } from './password-hash'
import {
	InMemoryPasswordResetStore,
	PasswordResetManager,
	type PasswordResetMessage,
	changeUserPassword,
} from './password-reset'
import { InMemoryUserStore, type UserStore } from './user-store'

async function userWith(
	users: InMemoryUserStore,
	email: string,
	password = 'old-password',
): Promise<string> {
	const { hash, salt } = await hashPassword(password)
	return (await users.createUser({ email, passwordHash: hash, salt, name: 'U' })).id
}

async function passwordIs(
	users: InMemoryUserStore,
	userId: string,
	password: string,
): Promise<boolean> {
	const user = await users.findById(userId)
	return user ? verifyPassword(password, user.passwordHash, user.salt) : false
}

function setup(overrides: Partial<ConstructorParameters<typeof PasswordResetManager>[1]> = {}) {
	const users = new InMemoryUserStore()
	const sent: PasswordResetMessage[] = []
	const ended: string[] = []
	const manager = new PasswordResetManager(users, {
		url: (token) => `https://app.test/reset-password#${token}`,
		send: (message) => {
			sent.push(message)
		},
		onPasswordChanged: (userId) => {
			ended.push(userId)
		},
		...overrides,
	})
	const tokenOf = (message: PasswordResetMessage | undefined): string =>
		message ? message.url.slice(message.url.indexOf('#') + 1) : ''
	return { users, sent, ended, manager, tokenOf }
}

afterEach(() => {
	vi.useRealTimers()
})

describe('PasswordResetManager', () => {
	test('a link sets the password once, ends every session and verifies the address', async () => {
		const { users, sent, ended, manager, tokenOf } = setup()
		const id = await userWith(users, 'Ann@Example.com')
		expect(await manager.request('  ANN@example.com ')).toBe('sent')
		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({ to: 'ann@example.com', userId: id })
		const token = tokenOf(sent[0])
		expect(await manager.reset(token, 'new-password')).toEqual({ ok: true, userId: id })
		expect(await passwordIs(users, id, 'new-password')).toBe(true)
		expect(ended).toEqual([id])
		expect((await users.findById(id))?.emailVerified).toBe(true)
		expect(await manager.reset(token, 'another-one')).toEqual({
			ok: false,
			code: 'RESET_TOKEN_INVALID',
		})
		expect(await passwordIs(users, id, 'new-password')).toBe(true)
	})

	test('an unknown address sends nothing, and says nothing', async () => {
		const { sent, manager } = setup()
		expect(await manager.request('nobody@example.com')).toBe('unknown-email')
		for (const bad of [undefined, 42, '', 'no-at-sign', `${'a'.repeat(260)}@x.y`]) {
			expect(await manager.request(bad)).toBe('invalid-email')
		}
		expect(sent).toHaveLength(0)
	})

	test('only the token hash is stored', async () => {
		const store = new InMemoryPasswordResetStore()
		const { users, sent, manager, tokenOf } = setup({ store })
		await userWith(users, 'a@example.com')
		await manager.request('a@example.com')
		const token = tokenOf(sent[0])
		expect(await store.get(token)).toBeNull()
		expect(
			JSON.stringify([...(store as unknown as { tokens: Map<string, unknown> }).tokens]),
		).not.toContain(token)
	})

	test('a rejected password leaves the link working', async () => {
		const { users, sent, manager, tokenOf } = setup()
		const id = await userWith(users, 'a@example.com')
		await manager.request('a@example.com')
		const token = tokenOf(sent[0])
		expect(await manager.reset(token, 'short')).toEqual({ ok: false, code: 'PASSWORD_TOO_SHORT' })
		expect(await manager.reset(token, 'x'.repeat(129))).toEqual({
			ok: false,
			code: 'PASSWORD_TOO_LONG',
		})
		expect(await manager.reset(token, 'long-enough')).toEqual({ ok: true, userId: id })
	})

	test('an expired link says so and changes nothing', async () => {
		vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
		const { users, sent, manager, tokenOf } = setup({ tokenTtlMs: 60_000 })
		const id = await userWith(users, 'a@example.com')
		await manager.request('a@example.com')
		vi.setSystemTime(1_000_000 + 60_001)
		expect(await manager.reset(tokenOf(sent[0]), 'new-password')).toEqual({
			ok: false,
			code: 'RESET_TOKEN_EXPIRED',
		})
		expect(await passwordIs(users, id, 'old-password')).toBe(true)
	})

	test('a link sent to a previous address resets nothing', async () => {
		const { users, sent, manager, tokenOf } = setup()
		const id = await userWith(users, 'old@example.com')
		await manager.request('old@example.com')
		const user = await users.findById(id)
		if (!user) throw new Error('no user')
		await users.update({ ...user, email: 'new@example.com' })
		expect(await manager.reset(tokenOf(sent[0]), 'new-password')).toEqual({
			ok: false,
			code: 'RESET_TOKEN_INVALID',
		})
		expect(await passwordIs(users, id, 'old-password')).toBe(true)
	})

	test('an address change while the reset runs leaves the password alone', async () => {
		const { users, sent, manager, tokenOf } = setup()
		const id = await userWith(users, 'old@example.com')
		await manager.request('old@example.com')
		const write = users.updatePasswordIf.bind(users)
		// The address changes after the link is taken, while the new password is hashed.
		users.updatePasswordIf = async (...args) => {
			const user = await users.findById(id)
			if (user) await users.update({ ...user, email: 'new@example.com' })
			return write(...args)
		}
		expect(await manager.reset(tokenOf(sent[0]), 'new-password')).toEqual({
			ok: false,
			code: 'RESET_TOKEN_INVALID',
		})
		expect(await passwordIs(users, id, 'old-password')).toBe(true)
	})

	test('two links used at once set one password; a change during a reset wins', async () => {
		const { users, sent, manager, tokenOf } = setup()
		const id = await userWith(users, 'a@example.com')
		await manager.request('a@example.com')
		await manager.request('a@example.com')
		const results = await Promise.all([
			manager.reset(tokenOf(sent[0]), 'first-password'),
			manager.reset(tokenOf(sent[1]), 'second-password'),
		])
		expect(results.filter((r) => r.ok)).toHaveLength(1)
		const winner = results[0]?.ok ? 'first-password' : 'second-password'
		expect(await passwordIs(users, id, winner)).toBe(true)

		await manager.request('a@example.com')
		const write = users.updatePasswordIf.bind(users)
		users.updatePasswordIf = async (userId, condition, hash, salt) => {
			// The user changes the password while the reset hashes.
			if (condition.email) users.updatePasswordIf = write
			if (condition.email)
				expect(await changeUserPassword(users, id, winner, 'changed-password')).toEqual({
					ok: true,
				})
			return write(userId, condition, hash, salt)
		}
		expect(await manager.reset(tokenOf(sent[2]), 'late-reset-pass')).toEqual({
			ok: false,
			code: 'RESET_TOKEN_INVALID',
		})
		expect(await passwordIs(users, id, 'changed-password')).toBe(true)
	})

	test('refuses a user store that cannot set a password conditionally', () => {
		const users = new InMemoryUserStore()
		const store = Object.assign(Object.create(Object.getPrototypeOf(users)), users, {
			updatePasswordIf: undefined,
		}) as UserStore
		expect(() => new PasswordResetManager(store, { url: (t) => t, send: () => {} })).toThrow(
			expect.objectContaining({ code: 'PASSWORD_RESET_STORE_UNSUPPORTED' }),
		)
	})

	test('using one link ends the others; a password change ends them too', async () => {
		const { users, sent, manager, tokenOf } = setup()
		const id = await userWith(users, 'a@example.com')
		await manager.request('a@example.com')
		await manager.request('a@example.com')
		expect((await manager.reset(tokenOf(sent[1]), 'new-password')).ok).toBe(true)
		expect(await manager.reset(tokenOf(sent[0]), 'attacker-pass')).toEqual({
			ok: false,
			code: 'RESET_TOKEN_INVALID',
		})

		await manager.request('a@example.com')
		expect(await manager.change(id, 'new-password', 'newer-password')).toEqual({ ok: true })
		expect(await manager.reset(tokenOf(sent[2]), 'attacker-pass')).toEqual({
			ok: false,
			code: 'RESET_TOKEN_INVALID',
		})
		expect(await passwordIs(users, id, 'newer-password')).toBe(true)
	})

	test('requests are limited per account, counted atomically; delivery failures leave no usable link', async () => {
		const { users, sent, manager } = setup({ maxPerHour: 2 })
		await userWith(users, 'a@example.com')
		const outcomes = await Promise.all(
			Array.from({ length: 6 }, () => manager.request('a@example.com')),
		)
		expect(outcomes.filter((o) => o === 'sent')).toHaveLength(2)
		expect(outcomes.filter((o) => o === 'rate-limited')).toHaveLength(4)
		expect(sent).toHaveLength(2)

		const failing = setup({
			send: () => {
				throw new Error('smtp down')
			},
		})
		const store = failing.manager.resetStore
		await userWith(failing.users, 'b@example.com')
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(await failing.manager.request('b@example.com')).toBe('delivery-failed')
		error.mockRestore()
		expect(await store.deleteExpired(Number.MAX_SAFE_INTEGER)).toBe(0)
	})

	test('malformed and unknown tokens answer the same', async () => {
		const { manager } = setup()
		for (const bad of [undefined, 42, '', 'short', 'x'.repeat(500), 'A'.repeat(43)]) {
			expect(await manager.reset(bad, 'new-password')).toEqual({
				ok: false,
				code: 'RESET_TOKEN_INVALID',
			})
		}
	})

	test('without onPasswordChanged, the user store’s revocations end the sessions', async () => {
		const revocations = new InMemoryTokenRevocationStore()
		const users = new InMemoryUserStore()
		vi.spyOn(users, 'getTokenRevocationStore').mockReturnValue(revocations)
		const sent: PasswordResetMessage[] = []
		const manager = new PasswordResetManager(users, {
			url: (token) => `#${token}`,
			send: (message) => {
				sent.push(message)
			},
		})
		const id = await userWith(users, 'a@example.com')
		await manager.request('a@example.com')
		await manager.reset((sent[0]?.url ?? '').slice(1), 'new-password')
		expect(await revocations.getUserRevokedBefore(id)).not.toBeNull()
	})
})

describe('changeUserPassword', () => {
	test('needs the current password, and changes only the password', async () => {
		const users = new InMemoryUserStore()
		const id = await userWith(users, 'a@example.com')
		expect(await changeUserPassword(users, id, 'wrong-password', 'new-password')).toEqual({
			ok: false,
			code: 'CURRENT_PASSWORD_INCORRECT',
		})
		expect(await changeUserPassword(users, id, undefined, 'new-password')).toEqual({
			ok: false,
			code: 'CURRENT_PASSWORD_INCORRECT',
		})
		expect(await changeUserPassword(users, id, 'old-password', 'tiny')).toEqual({
			ok: false,
			code: 'PASSWORD_TOO_SHORT',
		})
		expect(await changeUserPassword(users, 'nobody', 'old-password', 'new-password')).toEqual({
			ok: false,
			code: 'USER_NOT_FOUND',
		})
		expect(await changeUserPassword(users, id, 'old-password', 'new-password')).toEqual({
			ok: true,
		})
		expect(await passwordIs(users, id, 'new-password')).toBe(true)
	})

	test('a reset that lands while a change is being checked wins', async () => {
		const users = new InMemoryUserStore()
		const id = await userWith(users, 'a@example.com')
		const sent: PasswordResetMessage[] = []
		const manager = new PasswordResetManager(users, {
			url: (token) => `#${token}`,
			send: (message) => {
				sent.push(message)
			},
			onPasswordChanged: () => {},
		})
		await manager.request('a@example.com')
		// The change has checked the old password; the victim resets before it writes.
		const changed = await changeUserPassword(
			users,
			id,
			'old-password',
			'attacker-pass',
			async () => {
				expect((await manager.reset((sent[0]?.url ?? '').slice(1), 'victim-pass')).ok).toBe(true)
				return true
			},
		)
		expect(changed).toEqual({ ok: false, code: 'CURRENT_PASSWORD_INCORRECT' })
		expect(await passwordIs(users, id, 'victim-pass')).toBe(true)
	})

	test('a session that ended while the change was being checked changes nothing', async () => {
		const users = new InMemoryUserStore()
		const id = await userWith(users, 'a@example.com')
		expect(
			await changeUserPassword(users, id, 'old-password', 'new-password', async () => false),
		).toEqual({
			ok: false,
			code: 'SESSION_ENDED',
		})
		expect(await passwordIs(users, id, 'old-password')).toBe(true)
	})

	test('a profile update made from an earlier copy does not undo a password change', async () => {
		const users = new InMemoryUserStore()
		const id = await userWith(users, 'a@example.com')
		const copy = await users.findById(id)
		if (!copy) throw new Error('no user')
		expect(await changeUserPassword(users, id, 'old-password', 'new-password')).toEqual({
			ok: true,
		})
		await users.update({ ...copy, name: 'Renamed' })
		expect(await passwordIs(users, id, 'new-password')).toBe(true)
		expect((await users.findById(id))?.name).toBe('Renamed')
	})

	test('a store without the conditional write cannot change passwords', async () => {
		const users = new InMemoryUserStore()
		const id = await userWith(users, 'a@example.com')
		const store = Object.assign(Object.create(Object.getPrototypeOf(users)), users, {
			updatePasswordIf: undefined,
		}) as UserStore
		await expect(
			changeUserPassword(store, id, 'old-password', 'new-password'),
		).rejects.toMatchObject({
			code: 'PASSWORD_CHANGE_STORE_UNSUPPORTED',
		})
		expect(await passwordIs(users, id, 'old-password')).toBe(true)
	})

	test('an account without a password (OAuth only) cannot change one: it resets', async () => {
		const users = new InMemoryUserStore()
		const user = await users.createUser({
			email: 'o@example.com',
			passwordHash: '',
			salt: '',
			name: 'O',
		})
		expect(await changeUserPassword(users, user.id, '', 'new-password')).toEqual({
			ok: false,
			code: 'CURRENT_PASSWORD_INCORRECT',
		})
	})
})
