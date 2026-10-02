/**
 * RT-24 repro (red team round 3, 2026-10-02): blob chunk requests are charged to the
 * per-session OPERATION budget (RT-17) and an over-budget request is answered "not
 * held", which the client treats as a hard failure. A large blob (one request per
 * chunk) therefore cannot be downloaded on a server with a tight operation budget.
 *
 * Asserts the CORRECT behaviour (fails before the fix): blob requests have their own
 * (generous) budget, and an over-budget request gets a retriable "throttled" answer
 * that the client backs off on instead of failing the transfer.
 */
import { defineSchema, t } from '@korajs/core'
import { TokenAuthProvider } from '@korajs/server'
import { afterEach, describe, expect, test } from 'vitest'
import { type ScopedNetwork, scopedNetwork, settle } from './scoped-network'

const schema = defineSchema({
	version: 1,
	collections: { files: { fields: { team: t.string(), doc: t.blob().optional() } } },
})

const auth = new TokenAuthProvider({
	validate: async (token) => ({ userId: token, scopes: { files: { team: 'red' } } }),
})

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

describe('RT-24: large blob downloads under a tight operation budget', () => {
	test('a 1000-chunk blob downloads from the central store', async () => {
		const central = new Map<string, Uint8Array>()
		net = await scopedNetwork(schema, {
			auth,
			maxOpsPerMinute: 50,
			resolveBlobChunk: async (hash) => central.get(hash) ?? null,
			persistBlobChunk: (hash, bytes) => {
				central.set(hash, bytes)
			},
		})
		const alice = await net.device({ name: 'alice', token: 'alice' })
		const bob = await net.device({ name: 'bob', token: 'bob' })
		await settle([alice, bob], 1)

		const bytes = new Uint8Array(16_000)
		// Pseudo-random so every 16-byte chunk is distinct (no dedup).
		let x = 12345
		for (let i = 0; i < bytes.length; i++) {
			x = (x * 1664525 + 1013904223) >>> 0
			bytes[i] = x >>> 24
		}
		const { ref, manifest } = await alice.putBlob(bytes, { chunkSize: 16 })
		expect(manifest.chunkHashes.length).toBe(1000)
		await alice.collection('files').insert({ team: 'red', doc: ref })
		await settle([alice, bob])
		await alice.disconnect()

		const result = await bob.pullBlobByRef(ref)
		expect(result.chunksFetched).toBe(1000)
		expect(result.ref.hash).toBe(ref.hash)
		expect(await bob.getBlobBytes(ref.hash)).toEqual(bytes)
	}, 120_000)
})
