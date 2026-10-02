import { HybridLogicalClock, createOperation } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { verifyInboundOperation } from '../engine/verify-inbound'
import { JsonMessageSerializer, ProtobufMessageSerializer } from '../protocol/serializer'
import { generateSalt } from './key-derivation'
import { DecryptionError, SyncEncryptor } from './sync-encryptor'

/**
 * Encryption envelope v2 (protocol v2, ENC-3, NEW-ENC-1): every ciphertext is bound by
 * AES-GCM additional data to its operation's metadata, member and key version; the id
 * is the version-2 hash of the plaintext and verifies after decryption.
 */
const ITERATIONS = 1_000

async function pair(): Promise<[SyncEncryptor, SyncEncryptor]> {
	const salt = generateSalt()
	return [
		await SyncEncryptor.create({ enabled: true, key: 'shared' }, salt, ITERATIONS),
		await SyncEncryptor.create({ enabled: true, key: 'shared' }, salt, ITERATIONS),
	]
}

async function realOp(overrides: Partial<Parameters<typeof createOperation>[0]> = {}) {
	return createOperation(
		{
			nodeId: 'node-a',
			type: 'update',
			collection: 'accounts',
			recordId: 'acct-1',
			data: { balance: 10, ownerId: 'u1' },
			previousData: { balance: 5 },
			sequenceNumber: 4,
			causalDeps: ['dep-1'],
			schemaVersion: 1,
			atomicOps: { balance: { type: 'increment', value: 5 } },
			...overrides,
		},
		new HybridLogicalClock('node-a'),
	)
}

describe('envelope v2 round trip', () => {
	test('a sealed version-2 op opens on another device and its id verifies', async () => {
		const [a, b] = await pair()
		const op = await realOp()
		const sealed = await a.encryptOperation(op)
		expect(sealed.data).toBeNull()
		expect(sealed.previousData).toBeNull()
		expect(sealed.atomicOps).toBeUndefined()
		expect(sealed.encrypted?.atomicOps).toBeDefined()
		expect(sealed.id).toBe(op.id)

		for (const serializer of [new JsonMessageSerializer(), new ProtobufMessageSerializer()]) {
			const wire = serializer.decode(
				serializer.encode({
					type: 'operation-batch',
					messageId: 'm',
					operations: [serializer.encodeOperation(sealed)],
					isFinal: true,
					batchIndex: 0,
				}),
			)
			if (wire.type !== 'operation-batch') throw new Error('wrong message')
			const received = serializer.decodeOperation(wire.operations[0] as never)
			const opened = await b.decryptOperation(received)
			expect(opened.data).toEqual(op.data)
			expect(opened.previousData).toEqual(op.previousData)
			expect(opened.atomicOps).toEqual(op.atomicOps)
			expect(opened.encrypted).toBeUndefined()
			expect(await verifyInboundOperation(opened, { encrypted: true })).toEqual({
				ok: true,
				verified: true,
			})
		}
	})

	test('documented cleartext scope fields travel beside the envelope', async () => {
		const salt = generateSalt()
		const enc = await SyncEncryptor.create(
			{ enabled: true, key: 'k', cleartextFields: { accounts: ['ownerId'] } },
			salt,
			ITERATIONS,
		)
		const sealed = await enc.encryptOperation(await realOp())
		expect(sealed.data).toEqual({ ownerId: 'u1' })
		// The authoritative copy is the ciphertext: a rewritten cleartext copy is ignored.
		const opened = await enc.decryptOperation({ ...sealed, data: { ownerId: 'mallory' } })
		expect(opened.data).toEqual({ balance: 10, ownerId: 'u1' })
	})
})

describe('ENC-3: ciphertext is bound to its operation', () => {
	const tampers: Array<[string, (op: Operation) => Operation]> = [
		['nodeId', (op) => ({ ...op, nodeId: 'node-b' })],
		['collection', (op) => ({ ...op, collection: 'audit' })],
		['recordId', (op) => ({ ...op, recordId: 'acct-2' })],
		['type', (op) => ({ ...op, type: 'insert' })],
		['timestamp', (op) => ({ ...op, timestamp: { ...op.timestamp, wallTime: 1 } })],
		['sequenceNumber', (op) => ({ ...op, sequenceNumber: 99 })],
		[
			'keyVersion',
			(op) => ({ ...op, encrypted: op.encrypted && { ...op.encrypted, keyVersion: 2 } }),
		],
		['hashVersion downgrade', (op) => ({ ...op, hashVersion: 1 })],
		[
			'members swapped (data <-> previousData)',
			(op) => ({
				...op,
				encrypted: op.encrypted && {
					...op.encrypted,
					data: op.encrypted.previousData,
					previousData: op.encrypted.data,
				},
			}),
		],
	]
	for (const [name, tamper] of tampers) {
		test(`rewriting ${name} fails decryption`, async () => {
			const [a, b] = await pair()
			const sealed = await a.encryptOperation(await realOp())
			await expect(b.decryptOperation(tamper(sealed))).rejects.toThrow(DecryptionError)
		})
	}

	test('an envelope moved onto another operation fails authentication', async () => {
		const [a, b] = await pair()
		const first = await a.encryptOperation(await realOp())
		const second = await a.encryptOperation(await realOp({ recordId: 'acct-2' }))
		await expect(b.decryptOperation({ ...second, encrypted: first.encrypted })).rejects.toThrow(
			DecryptionError,
		)
	})

	test('rewritten cleartext metadata the AAD does not cover is caught by the id check', async () => {
		const [a, b] = await pair()
		const sealed = await a.encryptOperation(await realOp())
		// causalDeps and schemaVersion are not in the AAD; the version-2 id covers them.
		for (const forged of [
			{ ...sealed, causalDeps: [] },
			{ ...sealed, schemaVersion: 7 },
		]) {
			const opened = await b.decryptOperation(forged)
			const verdict = await verifyInboundOperation(opened, { encrypted: true })
			expect(verdict.ok).toBe(false)
		}
	})

	test('a key-id mismatch is diagnosable (ENC-1 stays Phase 4)', async () => {
		const a = await SyncEncryptor.create({ enabled: true, key: 'same' }, generateSalt(), ITERATIONS)
		const b = await SyncEncryptor.create({ enabled: true, key: 'same' }, generateSalt(), ITERATIONS)
		const sealed = await a.encryptOperation(await realOp())
		await expect(b.decryptOperation(sealed)).rejects.toMatchObject({
			context: expect.objectContaining({ code: 'KEY_ID_MISMATCH', keyId: sealed.encrypted?.keyId }),
		})
	})
})

describe('verifyInboundOperation (client side, CORE-1)', () => {
	test('a plaintext version-2 op verifies; a tampered one does not', async () => {
		const op = await realOp()
		expect((await verifyInboundOperation(op, { encrypted: false })).ok).toBe(true)
		const forged = { ...op, previousData: { balance: 0 } }
		const verdict = await verifyInboundOperation(forged, { encrypted: false })
		expect(verdict).toMatchObject({ ok: false, code: 'INVALID_OPERATION_ID' })
	})

	test('version-1 ops are never judged by version-2 rules', async () => {
		const legacy = await createOperation(
			{
				nodeId: 'node-a',
				type: 'insert',
				collection: 'accounts',
				recordId: 'r',
				data: { balance: 1 },
				previousData: null,
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			},
			new HybridLogicalClock('node-a'),
			{ hashVersion: 1 },
		)
		// Even a server-transformed copy (rewritten under the original id) is accepted.
		const transformed = { ...legacy, data: { balance: 1, currency: 'EUR' }, schemaVersion: 2 }
		expect(await verifyInboundOperation(transformed, { encrypted: false })).toEqual({
			ok: true,
			verified: false,
		})
	})

	test('server-synthesized scope entries (reserved kora: node) are not content-addressed', async () => {
		const op = await realOp()
		const entry = {
			...op,
			id: 'scope-entry-x',
			nodeId: 'kora:scope-entry',
			hashVersion: 2 as const,
		}
		expect((await verifyInboundOperation(entry, { encrypted: false })).ok).toBe(true)
	})

	test('an unknown declared hash version fails closed', async () => {
		const op = await realOp()
		const future = { ...op, hashVersion: 3 } as unknown as Operation
		expect((await verifyInboundOperation(future, { encrypted: false })).ok).toBe(false)
	})
})
