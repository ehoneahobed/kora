import { createHmac } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
	InMemoryTotpStore,
	TotpManager,
	type TotpSecret,
	type TotpStore,
	base32Decode,
} from './totp'

/**
 * Code checks under concurrency (AUTH-10). A persistent store returns a copy of the stored
 * secret, and each read and write yields: two requests with the same code, or many wrong
 * guesses in parallel, interleave between load and save.
 */

function codeAt(base32Secret: string, offsetSteps = 0): string {
	const counter = Math.floor(Date.now() / 1000 / 30) + offsetSteps
	const buffer = Buffer.alloc(8)
	buffer.writeBigUInt64BE(BigInt(counter))
	const hash = createHmac('sha1', Buffer.from(base32Decode(base32Secret)))
		.update(buffer)
		.digest()
	const offset = (hash[hash.length - 1] as number) & 0x0f
	const binary = hash.readUInt32BE(offset) & 0x7fffffff
	return String(binary % 1_000_000).padStart(6, '0')
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Like a database row: reads and writes copy, and yield. No conditional save. */
class CopyingStore implements TotpStore {
	protected readonly rows = new Map<string, TotpSecret>()
	async save(secret: TotpSecret): Promise<void> {
		await turn()
		this.rows.set(secret.userId, structuredClone(secret))
	}
	async getByUserId(userId: string): Promise<TotpSecret | null> {
		await turn()
		const row = this.rows.get(userId)
		return row ? structuredClone(row) : null
	}
	async delete(userId: string): Promise<void> {
		this.rows.delete(userId)
	}
}

/** The same, with the atomic conditional save a store shared by several servers provides. */
class ConditionalStore extends CopyingStore {
	async saveIf(secret: TotpSecret, expectedRevision: number): Promise<boolean> {
		await turn()
		const current = this.rows.get(secret.userId)
		if ((current?.revision ?? 0) !== expectedRevision) return false
		this.rows.set(secret.userId, structuredClone(secret))
		return true
	}
}

async function enrolled(store: TotpStore) {
	const manager = new TotpManager({ issuer: 'Test', store })
	const setup = await manager.enable('user-1', 'alice@example.com')
	await manager.verifySetup('user-1', codeAt(setup.secret, -1))
	return { manager, setup }
}

const successes = (results: boolean[]) => results.filter(Boolean).length

describe.each([
	['a copying store', () => new CopyingStore()],
	['a store with saveIf', () => new ConditionalStore()],
	['InMemoryTotpStore', () => new InMemoryTotpStore()],
])('TOTP checks are atomic with %s', (_name, makeStore) => {
	test('the same code sent twice at once signs in once', async () => {
		const { manager, setup } = await enrolled(makeStore())
		const code = codeAt(setup.secret)
		expect(
			successes(
				await Promise.all([manager.verify('user-1', code), manager.verify('user-1', code)]),
			),
		).toBe(1)
	})

	test('the same recovery code sent twice at once is accepted once', async () => {
		const { manager, setup } = await enrolled(makeStore())
		const recovery = setup.recoveryCodes[0] as string
		const results = await Promise.all([
			manager.verifyRecoveryCode('user-1', recovery),
			manager.verifyRecoveryCode('user-1', recovery),
		])
		expect(successes(results)).toBe(1)
	})

	test('wrong codes sent in parallel are all counted, and lock at the limit', async () => {
		const store = makeStore()
		const { manager } = await enrolled(store)
		await Promise.all(Array.from({ length: 4 }, () => manager.verify('user-1', '000000')))
		expect((await store.getByUserId('user-1'))?.failedAttempts).toBe(4)
		await Promise.all(Array.from({ length: 3 }, () => manager.verify('user-1', '000000')))
		// The fifth failure locks; attempts while locked are not evaluated, so not counted.
		const after = await store.getByUserId('user-1')
		expect(after?.failedAttempts).toBe(5)
		expect(after?.lockedUntil).toBeGreaterThan(Date.now())
	})
})

describe('a store without saveIf (review RT round 1)', () => {
	test('two managers sharing it would race, so a manager refuses it', async () => {
		const store = new CopyingStore()
		expect(() => new TotpManager({ issuer: 'Test', store })).toThrow(/saveIf/)
	})
})

describe('several servers sharing one store (saveIf)', () => {
	test('property: any number of concurrent attempts with one code, across servers, sign in once', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 2, max: 6 }),
				fc.integer({ min: 1, max: 3 }),
				async (attempts, servers) => {
					const store = new ConditionalStore()
					const { setup } = await enrolled(store)
					const managers = Array.from(
						{ length: servers },
						() => new TotpManager({ issuer: 'Test', store }),
					)
					const code = codeAt(setup.secret)
					const results = await Promise.all(
						Array.from({ length: attempts }, (_, i) =>
							(managers[i % servers] as TotpManager).verify('user-1', code),
						),
					)
					expect(successes(results)).toBe(1)
				},
			),
			{ numRuns: 40 },
		)
	})
})
