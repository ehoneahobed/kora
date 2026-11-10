/**
 * Prefix of a blinded element or key entry in a fold state. Canonical JSON (an element's
 * key) never starts with a NUL, and an object key that does cannot collide with a digest
 * a replica did not derive.
 */
const BLINDED_PREFIX = '\u0000h:'

const K = new Uint32Array(64)
const H0 = new Uint32Array(8)

/** Round constants of SHA-256: the fractional bits of the cube roots of the first primes. */
function initConstants(): void {
	if (K[0] !== 0) return
	let found = 0
	for (let n = 2; found < 64; n++) {
		let prime = true
		for (let d = 2; d * d <= n; d++) {
			if (n % d === 0) {
				prime = false
				break
			}
		}
		if (!prime) continue
		if (found < 8) H0[found] = (Math.sqrt(n) % 1) * 2 ** 32
		K[found] = (Math.cbrt(n) % 1) * 2 ** 32
		found++
	}
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/**
 * SHA-256 of a string, hex encoded. Synchronous, unlike Web Crypto, because a replica needs
 * it inside a merge, and a merge never awaits.
 */
export function sha256HexSync(text: string): string {
	initConstants()
	const message = new TextEncoder().encode(text)
	const length = ((message.length + 9 + 63) >>> 6) << 6
	const padded = new Uint8Array(length)
	padded.set(message)
	padded[message.length] = 0x80
	const view = new DataView(padded.buffer)
	view.setUint32(length - 8, Math.floor((message.length * 8) / 2 ** 32))
	view.setUint32(length - 4, (message.length * 8) >>> 0)
	const h = H0.slice()
	const w = new Uint32Array(64)
	for (let offset = 0; offset < length; offset += 64) {
		for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4)
		for (let t = 16; t < 64; t++) {
			const a = w[t - 15] as number
			const b = w[t - 2] as number
			const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
			const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
			w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0
		}
		const v = h.slice()
		for (let t = 0; t < 64; t++) {
			const [a, b, c, d, e, f, g, last] = v as unknown as number[] as [
				number,
				number,
				number,
				number,
				number,
				number,
				number,
				number,
			]
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
			const t1 = last + s1 + ((e & f) ^ (~e & g)) + (K[t] as number) + (w[t] as number)
			const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
			const t2 = s0 + ((a & b) ^ (a & c) ^ (b & c))
			v[7] = g
			v[6] = f
			v[5] = e
			v[4] = d + t1
			v[3] = c
			v[2] = b
			v[1] = a
			v[0] = t1 + t2
		}
		for (let i = 0; i < 8; i++) h[i] = ((h[i] as number) + (v[i] as number)) | 0
	}
	return Array.from(h, (word) => word.toString(16).padStart(8, '0')).join('')
}

/** The salt of one field's blinded entries: the same on every replica, different per record. */
export function blindSalt(collection: string, recordId: string, field: string): string {
	return `${collection}\u0000${recordId}\u0000${field}`
}

/** The entry key that stands for `key` (an element or object key) without showing it. */
export function blindedKey(salt: string, key: string): string {
	return `${BLINDED_PREFIX}${sha256HexSync(`kora/blind/v1\u0000${salt}\u0000${key}`)}`
}

/** True when `key` is a blinded entry key. */
export function isBlindedKey(key: string): boolean {
	return key.startsWith(BLINDED_PREFIX)
}

/** True when any own key of `entries` is blinded (none in nearly every state). */
export function hasBlindedKeys(entries: object): boolean {
	return Object.keys(entries).some(isBlindedKey)
}
