import { bytesToBase64, computeOperationId, defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	operationIdMatches,
	restoreUndefinedFromPrevious,
	verifyInboundOperation,
} from './verify-inbound'

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

describe('verifyInboundOperation: beta.12 hashes of undefined members (RT-71)', () => {
	const schema = defineSchema({
		version: 1,
		collections: {
			notes: {
				fields: {
					title: t.string(),
					assignee: t.string().optional(),
					meta: t.object({ a: t.number().optional(), b: t.string().optional() }).optional(),
				},
			},
		},
	}) as unknown as SchemaDefinition

	/** A beta.12 upload: id over the in-memory data, content after a JSON round trip. */
	async function legacyUpload(partial: Partial<Operation>): Promise<Operation> {
		return JSON.parse(JSON.stringify(await v1Op(partial))) as Operation
	}

	test('an update clearing a field with undefined verifies; its data is restored as null', async () => {
		const op = await legacyUpload({
			type: 'update',
			data: { title: 'y', assignee: undefined },
			previousData: { title: 'x', assignee: 'bob' },
		})
		expect(op.data).toEqual({ title: 'y' })
		const result = await verifyInboundOperation(op, {
			encrypted: false,
			absentVersion: 'verify-ids',
		})
		expect(result).toEqual({
			ok: true,
			verified: true,
			matchedVersion: 1,
			declarable: true,
			restoredData: { title: 'y', assignee: null },
		})
		// The restored copy, declared version 1, verifies on a client without the schema.
		const stored = { ...op, data: { title: 'y', assignee: null }, hashVersion: 1 as const }
		expect(await verifyInboundOperation(stored, { encrypted: false })).toEqual({
			ok: true,
			verified: true,
		})
		expect(await operationIdMatches(stored)).toBe(true)
	})

	test('a nested undefined member verifies only with the schema, and is not declarable', async () => {
		const op = await legacyUpload({ data: { title: 'x', meta: { a: 1, b: undefined } } })
		expect(
			(await verifyInboundOperation(op, { encrypted: false, absentVersion: 'verify-ids' })).ok,
		).toBe(false)
		expect(
			await verifyInboundOperation(op, { encrypted: false, absentVersion: 'verify-ids', schema }),
		).toEqual({ ok: true, verified: true, matchedVersion: 1, declarable: false })
	})

	test('both rebuilds together (a nested value plus a cleared field)', async () => {
		const op = await legacyUpload({
			type: 'update',
			data: { meta: { a: 2, b: undefined }, assignee: undefined },
			previousData: { meta: null, assignee: 'bob' },
		})
		expect(
			await verifyInboundOperation(op, { encrypted: false, absentVersion: 'verify-ids', schema }),
		).toMatchObject({ ok: true, verified: true, declarable: false })
	})

	test('a rebuild never turns altered content into a verified id', async () => {
		const op = await legacyUpload({
			type: 'update',
			data: { title: 'y' },
			previousData: { title: 'x', assignee: 'bob' },
		})
		const forged = { ...op, data: { title: 'z' } }
		const result = await verifyInboundOperation(forged, {
			encrypted: false,
			absentVersion: 'verify-ids',
			schema,
		})
		expect(result.ok).toBe(false)
	})

	test('restoreUndefinedFromPrevious restores only absent previousData keys of updates', async () => {
		const update = await v1Op({
			type: 'update',
			data: { title: 'y' },
			previousData: { title: 'x', assignee: 'bob' },
		})
		expect(restoreUndefinedFromPrevious(update)).toEqual({ title: 'y', assignee: null })
		const insert = await v1Op()
		expect(restoreUndefinedFromPrevious(insert)).toBe(insert.data)
		const full = await v1Op({ type: 'update', data: { title: 'y' }, previousData: { title: 'x' } })
		expect(restoreUndefinedFromPrevious(full)).toBe(full.data)
	})

	test('a version-2 id covers the JSON form: an undefined member is absent (RT-72)', async () => {
		const base = await v1Op({ data: { title: 'x', meta: { a: 1, b: undefined } } })
		const v2 = { ...base, hashVersion: 2 as const }
		const id = await computeOperationId(v2, 2)
		const uploaded = JSON.parse(JSON.stringify({ ...v2, id })) as Operation
		expect(await verifyInboundOperation(uploaded, { encrypted: false })).toEqual({
			ok: true,
			verified: true,
		})
	})
})

describe('verifyInboundOperation: beta.12 hashes of Date values in json (RT-88)', () => {
	/** A beta.12 write: the id over the Date, the data after the JSON log and wire. */
	async function dateOp(data: Record<string, unknown>): Promise<Operation> {
		const op = await v1Op({ data })
		return JSON.parse(JSON.stringify(op)) as Operation
	}

	test('a Date member, a top-level Date and Dates in arrays verify as version 1', async () => {
		for (const data of [
			{ title: 'x', extra: { when: new Date(1_700_000_000_000) } },
			{ title: 'x', extra: new Date(-62_198_755_200_000) },
			{ title: 'x', extra: [new Date(0), 'plain', { at: new Date(8.64e15) }] },
		]) {
			const op = await dateOp(data)
			expect(await operationIdMatches(op)).toBe(true)
			// Accepted, but never declared: the id did not bind the Date's value.
			expect(
				await verifyInboundOperation(op, { encrypted: false, absentVersion: 'verify-ids' }),
			).toMatchObject({ ok: true, verified: true, matchedVersion: 1, declarable: false })
		}
	})

	test('a Date next to a genuine ISO string verifies (every combination is tried)', async () => {
		const op = await dateOp({
			title: '2023-11-14T22:13:20.000Z',
			extra: { a: new Date(5), b: '1970-01-01T00:00:00.000Z' },
		})
		expect(await operationIdMatches(op)).toBe(true)
	})

	test('the rebuild still binds everything but the Date values', async () => {
		const op = await dateOp({ title: 'x', extra: { when: new Date(1_700_000_000_000) } })
		const retitled = { ...op, data: { title: 'y', extra: { when: '2023-11-14T22:13:20.000Z' } } }
		expect(await operationIdMatches(retitled)).toBe(false)
		const notADate = { ...op, data: { title: 'x', extra: { when: 'yesterday' } } }
		expect(await operationIdMatches(notADate)).toBe(false)
		// beta.12 hashed every Date as {}: its id never covered which instant it held.
		const otherInstant = {
			...op,
			data: { title: 'x', extra: { when: '2024-01-01T00:00:00.000Z' } },
		}
		expect(await operationIdMatches(otherInstant)).toBe(true)
	})
})
