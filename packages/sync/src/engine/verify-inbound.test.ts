import { bytesToBase64, computeOperationId } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { verifyInboundOperation } from './verify-inbound'

async function v1Op(partial: Partial<Operation> = {}): Promise<Operation> {
	const base: Operation = {
		id: '',
		nodeId: 'device-a',
		type: 'insert',
		collection: 'notes',
		recordId: 'r1',
		data: { title: 'x' },
		previousData: null,
		timestamp: { wallTime: 1_790_000_000_000, logical: 0, nodeId: 'device-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	}
	return { ...base, id: await computeOperationId(base, 1) }
}

describe('verifyInboundOperation: version-1 ids (RT-64)', () => {
	test('a declared version-1 id is verified on clients', async () => {
		const op = { ...(await v1Op()), hashVersion: 1 as const }
		expect(await verifyInboundOperation(op, { encrypted: false })).toEqual({
			ok: true,
			verified: true,
		})
		const forged = { ...op, id: 'chosen-id' }
		expect(await verifyInboundOperation(forged, { encrypted: false })).toMatchObject({
			ok: false,
			code: 'INVALID_OPERATION_ID',
		})
		const altered = { ...op, data: { title: 'changed' } }
		expect((await verifyInboundOperation(altered, { encrypted: false })).ok).toBe(false)
	})

	test('an absent version is skipped by default and verified as version 1 on request', async () => {
		const forged = { ...(await v1Op()), id: 'chosen-id' }
		expect(await verifyInboundOperation(forged, { encrypted: false })).toEqual({
			ok: true,
			verified: false,
		})
		expect(
			(await verifyInboundOperation(forged, { encrypted: false, absentVersion: 'verify-v1' })).ok,
		).toBe(false)
		const honest = await v1Op()
		expect(
			await verifyInboundOperation(honest, { encrypted: false, absentVersion: 'verify-v1' }),
		).toEqual({ ok: true, verified: true })
	})

	test('a version-1 id over bytes verifies in either binary form', async () => {
		const bytes = new Uint8Array([1, 2, 3, 250])
		const op = { ...(await v1Op({ data: { body: bytes } })), hashVersion: 1 as const }
		const roundTripped = { ...op, data: { body: { $koraBytes: bytesToBase64(bytes) } } }
		expect((await verifyInboundOperation(op, { encrypted: false })).ok).toBe(true)
		expect((await verifyInboundOperation(roundTripped, { encrypted: false })).ok).toBe(true)
		const asJson = { ...(await v1Op({ data: { body: { $koraBytes: bytesToBase64(bytes) } } })) }
		const decoded = { ...asJson, hashVersion: 1 as const, data: { body: bytes } }
		expect((await verifyInboundOperation(decoded, { encrypted: false })).ok).toBe(true)
	})

	test('operations of kora: nodes (server-derived ids, scope entries) are not checked', async () => {
		const serverOp = {
			...(await v1Op({ nodeId: 'kora:server:d:1' })),
			id: 'keyed-derived-id',
			hashVersion: 1 as const,
		}
		expect(await verifyInboundOperation(serverOp, { encrypted: false })).toEqual({
			ok: true,
			verified: false,
		})
	})
})
