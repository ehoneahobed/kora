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
			(await verifyInboundOperation(forged, { encrypted: false, absentVersion: 'verify-ids' })).ok,
		).toBe(false)
		const honest = await v1Op()
		expect(
			await verifyInboundOperation(honest, { encrypted: false, absentVersion: 'verify-ids' }),
		).toEqual({ ok: true, verified: true, matchedVersion: 1 })
		// A version-2 id whose declaration was lost still verifies (as version 2).
		const v2 = { ...honest, hashVersion: 2 as const }
		const { hashVersion: _lost, ...undeclared } = { ...v2, id: await computeOperationId(v2, 2) }
		expect(
			await verifyInboundOperation(undeclared as Operation, {
				encrypted: false,
				absentVersion: 'verify-ids',
			}),
		).toEqual({ ok: true, verified: true, matchedVersion: 2 })
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

	test('server-derived operations and scope entries (no declared version) are not checked', async () => {
		const { hashVersion: _none, ...derived } = {
			...(await v1Op({ nodeId: 'kora:server:d:1', causalDeps: ['parent'] })),
			id: 'keyed-derived-id',
			hashVersion: undefined,
		}
		for (const absentVersion of ['skip', 'verify-ids'] as const) {
			expect(await verifyInboundOperation(derived, { encrypted: false, absentVersion })).toEqual({
				ok: true,
				verified: false,
			})
		}
		const scopeEntry = {
			...(await v1Op({ nodeId: 'kora:scope-entry', sequenceNumber: 0 })),
			id: 'scope-entry-abc',
		}
		expect(
			await verifyInboundOperation(scopeEntry, { encrypted: false, absentVersion: 'verify-ids' }),
		).toEqual({ ok: true, verified: false })
	})

	test('a server route write (kora:server: node, declared hash version) is verified', async () => {
		const base = await v1Op({ nodeId: 'kora:server:d:1' })
		const route = { ...base, hashVersion: 2 as const }
		const honest = { ...route, id: await computeOperationId(route, 2) }
		expect(await verifyInboundOperation(honest, { encrypted: false })).toEqual({
			ok: true,
			verified: true,
		})
		expect(
			await verifyInboundOperation({ ...honest, id: 'chosen-id' }, { encrypted: false }),
		).toMatchObject({ ok: false, code: 'INVALID_OPERATION_ID' })
		expect(
			(
				await verifyInboundOperation(
					{ ...honest, data: { title: 'altered' } },
					{ encrypted: false },
				)
			).ok,
		).toBe(false)
		// A declared version 1 on a reserved node is verified too.
		const v1 = { ...base, hashVersion: 1 as const }
		expect((await verifyInboundOperation(v1, { encrypted: false })).ok).toBe(true)
		expect((await verifyInboundOperation({ ...v1, id: 'keyed' }, { encrypted: false })).ok).toBe(
			false,
		)
	})
})
