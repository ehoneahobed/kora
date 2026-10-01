/**
 * RT-1 repro (red team, 2026-10-01): the blob chunk relay is not tenant-aware.
 * - A chunk request is forwarded to every streaming session, leaking hashes across tenants.
 * - Any session can answer any pending requestId (poisoning).
 * - The central blob store serves any hash to any session (exfiltration).
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, makeOp, sha256Hex, tick } from './rt-fixture'

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

const secret = new TextEncoder().encode('alice payroll spreadsheet')

async function aliceFile(
	harness: Awaited<ReturnType<typeof createHarness>>,
	hash: string,
): Promise<void> {
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
	expect(await harness.store.findRecord('files', 'alice-file')).not.toBeNull()
}

function blobResponses(
	messages: SyncMessage[],
): Array<{ requestId: string; bytes: string | null }> {
	return messages
		.filter((m) => m.type === 'blob-chunk-response')
		.map((m) => m as unknown as { requestId: string; bytes: string | null })
}

describe('RT-1: blob relay crosses tenants', () => {
	test("the central store does not serve another tenant's blob (exfiltration)", async () => {
		const hash = await sha256Hex(secret)
		const central = new Map([[hash, secret]])
		const harness = await createHarness(schema, auth, {
			resolveBlobChunk: async (h) => central.get(h) ?? null,
		})
		await aliceFile(harness, hash)
		const bob = await harness.login('bob-token', 'bob-node')
		bob.send({ type: 'blob-chunk-request', messageId: 'r1', requestId: 'steal', hash })
		await tick(80)
		const leaked = blobResponses(bob.messages).filter((m) => m.bytes !== null)
		expect(leaked).toHaveLength(0)
	})

	test('the owner can still fetch its own blob from the central store', async () => {
		const hash = await sha256Hex(secret)
		const central = new Map([[hash, secret]])
		const harness = await createHarness(schema, auth, {
			resolveBlobChunk: async (h) => central.get(h) ?? null,
		})
		await aliceFile(harness, hash)
		const alice2 = await harness.login('alice-token-2', 'alice-node-2')
		alice2.send({ type: 'blob-chunk-request', messageId: 'r1', requestId: 'own', hash })
		await tick(80)
		expect(blobResponses(alice2.messages).some((m) => m.bytes !== null)).toBe(true)
	})

	test("a chunk request is not forwarded to another tenant's session (hash leak)", async () => {
		const harness = await createHarness(schema, auth)
		const alice = await harness.login('alice-token', 'alice-node')
		const bob = await harness.login('bob-token', 'bob-node')
		const hash = 'b'.repeat(64)
		bob.send({ type: 'blob-chunk-request', messageId: 'r1', requestId: 'probe', hash })
		await tick()
		expect(alice.messages.some((m) => m.type === 'blob-chunk-request')).toBe(false)
	})

	test('another tenant cannot answer a pending request (poisoning)', async () => {
		const hash = await sha256Hex(secret)
		const harness = await createHarness(schema, auth)
		await aliceFile(harness, hash)
		const alice1 = await harness.login('alice-token-1', 'alice-node-1')
		const alice2 = await harness.login('alice-token-2', 'alice-node-2')
		const bob = await harness.login('bob-token', 'bob-node')
		alice1.send({ type: 'blob-chunk-request', messageId: 'r1', requestId: 'alice-req', hash })
		await tick()
		// Bob was never asked, but answers the request id with forged bytes.
		bob.send({
			type: 'blob-chunk-response',
			messageId: 'x',
			requestId: 'alice-req',
			bytes: Buffer.from('forged').toString('base64'),
		})
		await tick()
		expect(blobResponses(alice1.messages)).toHaveLength(0)
		// The legitimate same-tenant peer was asked and can answer.
		expect(alice2.messages.some((m) => m.type === 'blob-chunk-request')).toBe(true)
		alice2.send({
			type: 'blob-chunk-response',
			messageId: 'y',
			requestId: 'alice-req',
			bytes: Buffer.from(secret).toString('base64'),
		})
		await tick()
		expect(blobResponses(alice1.messages).map((m) => m.bytes)).toEqual([
			Buffer.from(secret).toString('base64'),
		])
	})
})
