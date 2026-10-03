/**
 * RT-67 repro (Phase 3 red team, 2026-10-02): the fold voids the per-field versions of
 * a scope-entry insert that carries no fold state.
 *
 * Servers stamp a scope entry with the record's LATEST version and send each field's
 * own version in `fieldVersions` (RT-27). `fieldWriteStamp` returns
 * `max(fieldVersion, opStamp)`; the op stamp is the record's latest version, so every
 * field is stamped at the latest write of ANY field. A device's concurrent offline
 * edit of a field that the record's newest write did not touch (older than that write,
 * newer than the field's own version) loses to the server's restatement of the old
 * value. This is the path for a beta.13 server (no `foldState`, per the compatibility
 * matrix) and for any server store that cannot supply a fold state (the fallback in
 * `ClientSession`, and a carried state the receiver cannot read); beta.13 devices
 * honoured the per-field versions (`resolvePerFieldLww`).
 *
 * Asserts the CORRECT behaviour (fails at 959b791): the newer device edit survives.
 */
import { describe, expect, test } from 'vitest'
import { foldRecord, materialize } from '../../src/fold/fold'
import { defineSchema } from '../../src/schema/define'
import { t } from '../../src/schema/types'
import type { HLCTimestamp, Operation } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), body: t.string() } } },
})

const ts = (wallTime: number, nodeId: string): HLCTimestamp => ({ wallTime, logical: 0, nodeId })

function op(
	partial: Partial<Operation> & Pick<Operation, 'id' | 'nodeId' | 'timestamp'>,
): Operation {
	return {
		type: 'update',
		collection: 'notes',
		recordId: 'r1',
		data: null,
		previousData: null,
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	}
}

describe('RT-67: scope entry without fold state', () => {
	test('a device edit newer than the field version beats the restated value', () => {
		// The device knew the record (insert at t=100) and edited the title offline at t=300.
		const insert = op({
			id: 'ins',
			nodeId: 'a',
			type: 'insert',
			timestamp: ts(100, 'a'),
			data: { title: 'old', body: 'b0' },
		})
		const deviceEdit = op({
			id: 'edit',
			nodeId: 'device',
			timestamp: ts(300, 'device'),
			data: { title: 'device title' },
			previousData: { title: 'old' },
		})
		// The server's record: title last written at 100, body at 500. It restates the
		// record as a scope entry stamped at its latest version (500), with per-field versions.
		const scopeEntry = op({
			id: 'scope-entry-1',
			nodeId: 'kora:scope-entry',
			type: 'insert',
			timestamp: ts(500, 'b'),
			data: { title: 'old', body: 'b1' },
			fieldVersions: { title: ts(100, 'a'), body: ts(500, 'b') },
		})
		const state = foldRecord([insert, deviceEdit, scopeEntry], schema).state
		expect(state).not.toBeNull()
		expect(materialize(state as NonNullable<typeof state>)).toEqual({
			title: 'device title',
			body: 'b1',
		})
	})
})
