/**
 * Bloom filter for fast subscription dependency pre-checking.
 *
 * When the SubscriptionManager has many active subscriptions, checking whether a
 * mutation might affect any subscription requires scanning all subscriptions.
 * This bloom filter provides a fast O(k) pre-check: if the filter says "definitely
 * not present", we can skip the subscription entirely. If it says "maybe present",
 * we fall through to the precise collection/field matching.
 *
 * Uses FNV-1a for hashing and Kirsch-Mitzenmacker double hashing to derive k
 * hash functions from two base hashes.
 */

// FNV-1a constants for 32-bit hashes
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * Compute FNV-1a 32-bit hash of a string.
 *
 * FNV-1a is a non-cryptographic hash function optimized for speed and distribution.
 * It processes one byte at a time: XOR then multiply, which gives better avalanche
 * behavior than the original FNV-1 (multiply then XOR).
 *
 * @param input - The string to hash
 * @returns A 32-bit unsigned integer hash
 */
export function fnv1a32(input: string): number {
	let hash = FNV_OFFSET_BASIS
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i)
		// Math.imul gives true 32-bit integer multiplication without overflow issues
		hash = Math.imul(hash, FNV_PRIME)
	}
	// Ensure unsigned 32-bit result
	return hash >>> 0
}

/**
 * Calculate the optimal number of bits for a bloom filter.
 *
 * Formula: m = -(n * ln(p)) / (ln(2)^2)
 * Rounded up to the nearest multiple of 32 for Uint32Array alignment.
 *
 * @param expectedItems - Expected number of items to insert
 * @param falsePositiveRate - Desired false positive rate (0-1)
 * @returns Number of bits, rounded to nearest 32-bit multiple (minimum 32)
 */
export function optimalBitCount(expectedItems: number, falsePositiveRate: number): number {
	if (expectedItems <= 0) return 32
	if (falsePositiveRate <= 0 || falsePositiveRate >= 1) return 32

	const ln2Squared = Math.LN2 * Math.LN2
	const rawBits = -(expectedItems * Math.log(falsePositiveRate)) / ln2Squared

	// Round up to nearest 32-bit multiple for Uint32Array alignment
	const aligned = Math.ceil(rawBits / 32) * 32
	return Math.max(32, aligned)
}

/**
 * Calculate the optimal number of hash functions for a bloom filter.
 *
 * Formula: k = (m/n) * ln(2)
 * Clamped to [1, 30] to avoid degenerate cases.
 *
 * @param bitCount - Total number of bits in the filter
 * @param expectedItems - Expected number of items to insert
 * @returns Number of hash functions, clamped to [1, 30]
 */
export function optimalHashCount(bitCount: number, expectedItems: number): number {
	if (expectedItems <= 0) return 1
	const raw = (bitCount / expectedItems) * Math.LN2
	return Math.max(1, Math.min(30, Math.round(raw)))
}

/**
 * Bloom filter for subscription dependency tracking.
 *
 * Each subscription adds its watched collection (and optionally fields) to the
 * filter. When a mutation arrives, we check "collection" and "collection:field"
 * keys against the filter. A negative result means no subscription cares about
 * this mutation, so we can skip the expensive per-subscription scan.
 *
 * @example
 * ```typescript
 * const filter = new SubscriptionBloomFilter(100, 0.01)
 * filter.add('todos')
 * filter.add('todos', 'completed')
 *
 * filter.mightContain('todos')              // true (definitely added)
 * filter.mightContain('projects')           // false (definitely not added)
 * filter.mightContain('todos', 'completed') // true (definitely added)
 * ```
 */
export class SubscriptionBloomFilter {
	private bits: Uint32Array
	private readonly bitCount: number
	private readonly hashCount: number
	private itemCount = 0

	constructor(expectedItems: number, falsePositiveRate = 0.01) {
		this.bitCount = optimalBitCount(expectedItems, falsePositiveRate)
		this.hashCount = optimalHashCount(this.bitCount, expectedItems)
		this.bits = new Uint32Array(this.bitCount / 32)
	}

	/**
	 * Add a collection (and optional field) to the bloom filter.
	 *
	 * @param collection - Collection name (e.g., "todos")
	 * @param field - Optional field name (e.g., "completed")
	 */
	add(collection: string, field?: string): void {
		const key = field !== undefined ? `${collection}:${field}` : collection
		const positions = this.getPositions(key)
		for (const pos of positions) {
			const wordIndex = pos >>> 5 // equivalent to Math.floor(pos / 32)
			const bitIndex = pos & 31 // equivalent to pos % 32
			const current = this.bits[wordIndex] ?? 0
			this.bits[wordIndex] = current | (1 << bitIndex)
		}
		this.itemCount++
	}

	/**
	 * Check if a collection (and optional field) might be in the filter.
	 *
	 * A return value of `false` means the item is DEFINITELY NOT in the filter.
	 * A return value of `true` means the item MIGHT be in the filter (possible false positive).
	 *
	 * @param collection - Collection name to check
	 * @param field - Optional field name to check
	 * @returns false = definitely absent, true = possibly present
	 */
	mightContain(collection: string, field?: string): boolean {
		const key = field !== undefined ? `${collection}:${field}` : collection
		const positions = this.getPositions(key)
		for (const pos of positions) {
			const wordIndex = pos >>> 5
			const bitIndex = pos & 31
			if (((this.bits[wordIndex] ?? 0) & (1 << bitIndex)) === 0) {
				return false
			}
		}
		return true
	}

	/**
	 * Reset the bloom filter, clearing all bits and the item count.
	 */
	clear(): void {
		this.bits.fill(0)
		this.itemCount = 0
	}

	/**
	 * Estimate the current false positive rate based on the number of items inserted.
	 *
	 * Formula: (1 - e^(-kn/m))^k
	 * where k = hash count, n = item count, m = bit count.
	 *
	 * @returns Estimated false positive rate as a number between 0 and 1
	 */
	estimatedFalsePositiveRate(): number {
		if (this.itemCount === 0) return 0
		const exponent = -(this.hashCount * this.itemCount) / this.bitCount
		return (1 - Math.exp(exponent)) ** this.hashCount
	}

	/**
	 * @returns The number of items that have been added to the filter
	 */
	getItemCount(): number {
		return this.itemCount
	}

	/**
	 * @returns The total number of bits in the filter
	 */
	getBitCount(): number {
		return this.bitCount
	}

	/**
	 * @returns The number of hash functions used
	 */
	getHashCount(): number {
		return this.hashCount
	}

	/**
	 * Count the number of bits currently set to 1.
	 * Uses Brian Kernighan's algorithm: each iteration clears the lowest set bit,
	 * so the loop runs exactly as many times as there are set bits.
	 *
	 * @returns Number of bits set to 1
	 */
	getSetBitCount(): number {
		let count = 0
		for (let i = 0; i < this.bits.length; i++) {
			let word = this.bits[i] ?? 0
			while (word !== 0) {
				// Clear the lowest set bit: n & (n - 1) removes the rightmost 1-bit
				word &= word - 1
				count++
			}
		}
		return count
	}

	/**
	 * Compute k bit positions for a given key using Kirsch-Mitzenmacker double hashing.
	 *
	 * Instead of computing k independent hash functions, we compute two base hashes
	 * (h1 and h2) and derive the rest as: h_i = (h1 + i * h2) mod m.
	 * This technique is proven to have the same asymptotic false positive rate as
	 * k independent hash functions.
	 *
	 * We derive h1 and h2 from a single FNV-1a hash by splitting and mixing:
	 * h1 = fnv1a(key), h2 = fnv1a(key + "\0salt") to ensure independence.
	 */
	private getPositions(key: string): number[] {
		const h1 = fnv1a32(key)
		// Use a null-byte separator + salt suffix to derive a second independent hash
		const h2 = fnv1a32(`${key}\0bloom`)

		const positions = new Array<number>(this.hashCount)
		for (let i = 0; i < this.hashCount; i++) {
			// Combine h1 and h2 with Kirsch-Mitzenmacker technique
			positions[i] = ((h1 + Math.imul(i, h2)) >>> 0) % this.bitCount
		}
		return positions
	}
}
