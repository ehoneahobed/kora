/**
 * RT-11 repro (red team round 2, 2026-10-01): blob reference forging.
 *
 * Uplink authorization never looks at the hashes a blob field points at, so writing
 * `{ owner: self, doc: { hash: H } }` with someone else's hash H makes H "referenced
 * inside my scope": the central store then serves H, and the cross-scope forwarding
 * check passes. A content hash acts as a read capability. A crafted manifest listing
 * another tenant's chunk hashes does the same for chunks. Separately, every anonymous
 * session shares one scope partition, so blob requests are forwarded between
 * unrelated anonymous devices.
 *
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { MixedAuthProvider } from '../../src/auth/mixed-auth-provider'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { type Harness, batch, createHarness, makeOp, sha256Hex, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { files: { fields: { owner: t.string(), doc: t.blob().optional() } } },
})

const auth = new TokenAuthProvider({
	validate: async (token) =>
		token.startsWith('alice')
			? { userId: 'alice', scopes: { files: { owner: 'alice' } } }
			: token.startsWith('bob')
				? { userId: 'bob', scopes: { files: { owner: 'bob' } } }
				: null,
})

const enc = new TextEncoder()
const secret = enc.encode('alice payroll spreadsheet')
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

function centralStore(): {
	map: Map<string, Uint8Array>
	config: {
		resolveBlobChunk: (hash: string) => Promise<Uint8Array | null>
		persistBlobChunk: (hash: string, bytes: Uint8Array) => void
	}
} {
	const map = new Map<string, Uint8Array>()
	return {
		map,
		config: {
			resolveBlobChunk: async (hash) => map.get(hash) ?? null,
			persistBlobChunk: (hash, bytes) => {
				map.set(hash, bytes)
			},
		},
	}
}

function rejections(messages: SyncMessage[]): Array<{ operationId: string; code: string }> {
	return messages
		.filter((m) => m.type === 'operation-rejected')
		.map((m) => m as unknown as { operationId: string; code: string })
}

function blobBytesReceived(messages: SyncMessage[], requestId: string): string | null {
	for (const m of messages) {
		if (m.type !== 'blob-chunk-response') continue
		const r = m as unknown as { requestId: string; bytes: string | null }
		if (r.requestId === requestId && r.bytes !== null) return r.bytes
	}
	return null
}

async function aliceUploads(harness: Harness, hash: string, bytes: Uint8Array): Promise<void> {
	const alice = await harness.login('alice-token', 'alice-node-0')
	alice.send({ type: 'blob-chunk-push', messageId: 'p1', hash, bytes: b64(bytes) })
	alice.send(
		batch([
			makeOp('alice-node-0', 1, {
				collection: 'files',
				recordId: 'alice-file',
				data: { owner: 'alice', doc: { hash, size: bytes.byteLength } },
			}),
		]),
	)
	await tick()
	expect(await harness.store.findRecord('files', 'alice-file')).not.toBeNull()
}

describe('RT-11: blob reference forging', () => {
	test("a write referencing another tenant's hash is refused", async () => {
		const hash = await sha256Hex(secret)
		const central = centralStore()
		const harness = await createHarness(schema, auth, central.config)
		await aliceUploads(harness, hash, secret)

		const bob = await harness.login('bob-token', 'bob-node')
		const forged = makeOp('bob-node', 1, {
			collection: 'files',
			recordId: 'bob-forged',
			data: { owner: 'bob', doc: { hash, size: secret.byteLength } },
		})
		bob.send(batch([forged]))
		await tick()
		expect(rejections(bob.messages).map((r) => r.operationId)).toContain(forged.id)
		expect(await harness.store.findRecord('files', 'bob-forged')).toBeNull()

		// And the forged reference grants nothing from the central store.
		bob.send({ type: 'blob-chunk-request', messageId: 'r1', requestId: 'steal', hash })
		await tick(80)
		expect(blobBytesReceived(bob.messages, 'steal')).toBeNull()
	})

	test('a forged reference does not open cross-scope forwarding to the owner (peer mode)', async () => {
		const hash = await sha256Hex(secret)
		const harness = await createHarness(schema, auth)
		const alice = await harness.login('alice-token', 'alice-node-0')
		alice.send(
			batch([
				makeOp('alice-node-0', 1, {
					collection: 'files',
					recordId: 'alice-file',
					data: { owner: 'alice', doc: { hash, size: secret.byteLength } },
				}),
			]),
		)
		await tick()
		const bob = await harness.login('bob-token', 'bob-node')
		bob.send(
			batch([
				makeOp('bob-node', 1, {
					collection: 'files',
					recordId: 'bob-forged',
					data: { owner: 'bob', doc: { hash, size: secret.byteLength } },
				}),
			]),
		)
		await tick()
		bob.send({ type: 'blob-chunk-request', messageId: 'r1', requestId: 'probe', hash })
		await tick()
		expect(alice.messages.some((m) => m.type === 'blob-chunk-request')).toBe(false)
	})

	test("a crafted manifest listing another tenant's chunk does not expose the chunk", async () => {
		const central = centralStore()
		const harness = await createHarness(schema, auth, central.config)
		const chunkHash = await sha256Hex(secret)
		await aliceUploads(harness, chunkHash, secret)

		const bob = await harness.login('bob-token', 'bob-node')
		const manifestBytes = enc.encode(
			JSON.stringify({
				blobHash: 'c'.repeat(64),
				size: secret.byteLength,
				chunkSize: 1024,
				chunkHashes: [chunkHash],
			}),
		)
		const manifestHash = await sha256Hex(manifestBytes)
		bob.send({
			type: 'blob-chunk-push',
			messageId: 'p1',
			hash: manifestHash,
			bytes: b64(manifestBytes),
		})
		bob.send(
			batch([
				makeOp('bob-node', 1, {
					collection: 'files',
					recordId: 'bob-file',
					data: { owner: 'bob', doc: { hash: 'c'.repeat(64), size: 1, manifestHash } },
				}),
			]),
		)
		await tick()
		bob.send({ type: 'blob-chunk-request', messageId: 'r1', requestId: 'chunk', hash: chunkHash })
		await tick(80)
		expect(blobBytesReceived(bob.messages, 'chunk')).toBeNull()
	})

	test('a new blob, and a blob the writer pushed itself, are still accepted', async () => {
		const central = centralStore()
		const harness = await createHarness(schema, auth, central.config)
		const bob = await harness.login('bob-token', 'bob-node')
		// A brand-new blob: the client's outbound preparer pushes the bytes before the
		// batch that references them. (With a central store, a reference sent BEFORE its
		// bytes is refused since RT-25: a bare reference no longer claims a hash.)
		const fresh = enc.encode('bob holiday photo')
		const freshHash = await sha256Hex(fresh)
		bob.send({ type: 'blob-chunk-push', messageId: 'p1', hash: freshHash, bytes: b64(fresh) })
		const first = makeOp('bob-node', 1, {
			collection: 'files',
			recordId: 'bob-1',
			data: { owner: 'bob', doc: { hash: freshHash, size: fresh.byteLength } },
		})
		bob.send(batch([first]))
		// Bytes pushed first, referenced second.
		const pushed = enc.encode('bob tax return')
		const pushedHash = await sha256Hex(pushed)
		bob.send({ type: 'blob-chunk-push', messageId: 'p2', hash: pushedHash, bytes: b64(pushed) })
		await tick()
		const second = makeOp('bob-node', 2, {
			collection: 'files',
			recordId: 'bob-2',
			data: { owner: 'bob', doc: { hash: pushedHash, size: pushed.byteLength } },
		})
		bob.send(batch([second]))
		await tick()
		expect(rejections(bob.messages)).toEqual([])
		expect(await harness.store.findRecord('files', 'bob-1')).not.toBeNull()
		expect(await harness.store.findRecord('files', 'bob-2')).not.toBeNull()
		// Bob's second device reads both.
		const bob2 = await harness.login('bob-token-2', 'bob-node-2')
		bob2.send({ type: 'blob-chunk-request', messageId: 'r1', requestId: 'one', hash: freshHash })
		bob2.send({ type: 'blob-chunk-request', messageId: 'r2', requestId: 'two', hash: pushedHash })
		await tick(80)
		expect(blobBytesReceived(bob2.messages, 'one')).toBe(b64(fresh))
		expect(blobBytesReceived(bob2.messages, 'two')).toBe(b64(pushed))
	})

	test('anonymous sessions are not one blob partition', async () => {
		const mixed = new MixedAuthProvider({
			primary: auth,
			anonymousScopes: { files: { owner: 'public' } },
		})
		const harness = await createHarness(schema, mixed)
		const anon1 = await harness.login('', 'kiosk-1')
		const anon2 = await harness.login('', 'kiosk-2')
		anon1.send({
			type: 'blob-chunk-request',
			messageId: 'r1',
			requestId: 'probe',
			hash: 'd'.repeat(64),
		})
		await tick()
		expect(anon2.messages.some((m) => m.type === 'blob-chunk-request')).toBe(false)
	})
})
