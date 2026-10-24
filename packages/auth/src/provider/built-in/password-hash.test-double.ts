import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Test double for `password-hash.ts` with a cheap work factor. Tests that sign many accounts in
 * and out exercise device and rate-limit logic, not the hash; at 600,000 iterations they spend
 * their time on the shared CPU and hit the test timeout under load. The real hash has its own
 * tests (`password-hash.test.ts`).
 */
const ITERATIONS = 1_000

function derive(password: string, salt: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		pbkdf2(password, salt, ITERATIONS, 64, 'sha512', (err, key) =>
			err ? reject(err) : resolve(key),
		)
	})
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
	const salt = randomBytes(32)
	return { hash: (await derive(password, salt)).toString('hex'), salt: salt.toString('hex') }
}

export async function verifyPassword(
	password: string,
	hash: string,
	salt: string,
): Promise<boolean> {
	const key = await derive(password, Buffer.from(salt, 'hex'))
	const expected = Buffer.from(hash, 'hex')
	return key.length === expected.length && timingSafeEqual(key, expected)
}
