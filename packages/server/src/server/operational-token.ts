import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Whether a request's token equals the configured one, in constant time: both are hashed
 * (SHA-256) and the digests compared with `timingSafeEqual`, so neither the position of the
 * first wrong character nor the token's length shows in the response time.
 *
 * @param given - The token the request carried, if any
 * @param expected - The configured token
 */
export function tokensMatch(given: string | null | undefined, expected: string): boolean {
	const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()
	const a = digest(given ?? '')
	const b = digest(expected)
	// Always compared, so a missing token takes as long as a wrong one.
	return timingSafeEqual(a, b) && given !== null && given !== undefined
}
