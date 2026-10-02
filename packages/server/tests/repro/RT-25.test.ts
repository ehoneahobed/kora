/**
 * RT-25 repro (red team round 3, 2026-10-02): with a central blob store, a bare
 * reference to a hash nobody owns yet claims it. That is an existence oracle (the
 * claim succeeds only for content not held by anyone else) and lets the claimer
 * read the bytes once another tenant uploads that content later.
 *
 * Asserts the CORRECT behaviour (fails before the fix): in central-store mode a
 * reference is accepted only for content the writer pushed (or can already read in
 * its scope), and the store serves bytes only to owners or in-scope referencers.
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
	validate: async (token) => {
		const user = token.split('-')[0] ?? ''
		return { userId: user, scopes: { files: { owner: user } } }
	},
})

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

function rejectedIds(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) =>
		m.type === 'operation-rejected' ? [(m as { operationId: string }).operationId] : [],
	)
}

function bytesFor(messages: SyncMessage[], requestId: string): string | null {
	for (const m of messages) {
		if (m.type !== 'blob-chunk-response') continue
		const r = m as unknown as { requestId: string; bytes: string | null }
		if (r.requestId === requestId && r.bytes !== null) return r.bytes
	}
	return null
}

describe('RT-25: pre-claiming a content hash (central store)', () => {
	test('a bare reference cannot claim a hash, so it cannot read content uploaded later', async () => {
		const central = new Map<string, Uint8Array>()
		const harness = await createHarness(schema, auth, {
			resolveBlobChunk: async (hash) => central.get(hash) ?? null,
			persistBlobChunk: (hash, bytes) => {
				central.set(hash, bytes)
			},
		})
		const secret = new TextEncoder().encode('Q3 board minutes (draft)')
		const hash = await sha256Hex(secret)

		// Eve guesses the content and references its hash before anyone uploaded it.
		const eve = await harness.login('eve-token', 'eve-node')
		const preclaim = makeOp('eve-node', 1, {
			collection: 'files',
			recordId: 'eve-file',
			data: { owner: 'eve', doc: { hash, size: secret.byteLength } },
		})
		eve.send(batch([preclaim]))
		await tick()
		expect(rejectedIds(eve.messages)).toContain(preclaim.id)

		// Alice later uploads that exact content (bytes first, then the reference).
		const alice = await harness.login('alice-token', 'alice-node')
		alice.send({ type: 'blob-chunk-push', messageId: 'p1', hash, bytes: b64(secret) })
		const own = makeOp('alice-node', 1, {
			collection: 'files',
			recordId: 'alice-file',
			data: { owner: 'alice', doc: { hash, size: secret.byteLength } },
		})
		alice.send(batch([own]))
		await tick()
		expect(rejectedIds(alice.messages)).toEqual([])

		eve.send({ type: 'blob-chunk-request', messageId: 'r1', requestId: 'steal', hash })
		await tick(80)
		expect(bytesFor(eve.messages, 'steal')).toBeNull()
		// Alice reads her own content.
		alice.send({ type: 'blob-chunk-request', messageId: 'r2', requestId: 'mine', hash })
		await tick(80)
		expect(bytesFor(alice.messages, 'mine')).not.toBeNull()
	})
})
