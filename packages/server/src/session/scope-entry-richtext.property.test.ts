/**
 * A scope entry's richtext fold state (issue #80): updates that only repeat newer ones are
 * dropped and deleted text is gone, and everything a replica computes from the entry is what
 * it computes from the server's full state, including under resets that arrive late.
 */
import { fc, test as propTest } from '@fast-check/vitest'
import {
	type FoldState,
	type Operation,
	base64ToBytes,
	createFoldState,
	defineSchema,
	encodeBytesForOpData,
	joinStates,
	materialize,
	mergeOp,
	t,
} from '@korajs/core'
import { redactFoldState } from '@korajs/core/internal'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { mergeRichtextUpdatesForServer } from '../store/record-fold'
import { SCOPE_ENTRY_RICHTEXT, buildScopeEntryOperation } from './scope-entry'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.richtext() } } },
})
const options = { richtext: mergeRichtextUpdatesForServer }
const TEXT_KEY = 'content'

let opCounter = 0
function write(value: unknown, wall: number): Operation {
	opCounter += 1
	return {
		id: `op-${opCounter}`,
		nodeId: 'n',
		type: 'update',
		collection: 'notes',
		recordId: 'r',
		data: { body: value },
		previousData: {},
		timestamp: { wallTime: wall, logical: 0, nodeId: 'n' },
		sequenceNumber: opCounter,
		causalDeps: [],
		schemaVersion: 1,
	}
}
const snapshot = (update: Uint8Array, wall: number): Operation =>
	write(encodeBytesForOpData(update), wall)
const fold = (state: FoldState, op: Operation): FoldState =>
	mergeOp(state, op, schema, { traces: 'none' }).state
/** An inserted record: a state with only updates materializes to no record at all. */
const empty = (): FoldState =>
	fold(createFoldState('notes', 'r'), {
		...write(null, 1),
		type: 'insert',
		data: {},
		previousData: null,
	})
const redact = (state: FoldState): FoldState => redactFoldState(state, SCOPE_ENTRY_RICHTEXT)

/** What a user sees: the formatted text, or the reset's plain value. */
function shown(state: FoldState): unknown {
	const body = materialize(state, options)?.body as { $koraBytes: string } | string | undefined
	if (typeof body !== 'object' || body === null) return body ?? null
	const doc = new Y.Doc()
	Y.applyUpdate(doc, base64ToBytes(body.$koraBytes))
	return doc.getText(TEXT_KEY).toDelta()
}

function updatesText(state: FoldState): string {
	const field = state.f.body as { u: Record<string, unknown> }
	return Object.keys(field.u)
		.map((update) => new TextDecoder().decode(base64ToBytes(update)))
		.join('\n')
}

type Step =
	| { kind: 'type'; device: number; at: number; text: string }
	| { kind: 'erase'; device: number; at: number; length: number }
	| { kind: 'pull'; device: number; from: number }
	| { kind: 'save'; device: number; delta: boolean }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
	fc.record({
		kind: fc.constant('type' as const),
		device: fc.nat(2),
		at: fc.nat(30),
		text: fc.constantFrom('aa', 'bbb', 'c'),
	}),
	fc.record({
		kind: fc.constant('erase' as const),
		device: fc.nat(2),
		at: fc.nat(30),
		length: fc.integer({ min: 1, max: 4 }),
	}),
	fc.record({ kind: fc.constant('pull' as const), device: fc.nat(2), from: fc.nat(2) }),
	fc.record({ kind: fc.constant('save' as const), device: fc.nat(2), delta: fc.boolean() }),
)

/** Runs the edits with an editor's undo history on, saving a stamped update per `save`. */
function run(steps: Step[], firstClient = 1): Array<{ update: Uint8Array; wall: number }> {
	const docs = [0, 1, 2].map((index) => {
		const doc = new Y.Doc()
		doc.clientID = firstClient + index
		new Y.UndoManager(doc.getText(TEXT_KEY))
		return doc
	})
	const saved: Uint8Array[] = docs.map(() => new Uint8Array([0]))
	const out: Array<{ update: Uint8Array; wall: number }> = []
	let wall = 10
	for (const step of steps) {
		const doc = docs[step.device] as Y.Doc
		const text = doc.getText(TEXT_KEY)
		if (step.kind === 'type') text.insert(Math.min(step.at, text.length), step.text)
		else if (step.kind === 'erase') {
			const at = Math.min(step.at, text.length)
			text.delete(at, Math.min(step.length, text.length - at))
		} else if (step.kind === 'pull') {
			Y.applyUpdate(doc, Y.encodeStateAsUpdate(docs[step.from] as Y.Doc))
		} else {
			wall += 10
			const update = step.delta
				? Y.encodeStateAsUpdate(doc, saved[step.device])
				: Y.encodeStateAsUpdate(doc)
			saved[step.device] = Y.encodeStateVector(doc)
			out.push({ update, wall })
		}
	}
	return out
}

const stepsArb = fc.array(stepArb, { maxLength: 25 })

describe('a redacted richtext field merges like the full one', () => {
	propTest.prop([stepsArb])('same document', (steps) => {
		const server = run(steps).reduce((s, u) => fold(s, snapshot(u.update, u.wall)), empty())
		expect(shown(redact(server))).toEqual(shown(server))
	})

	propTest.prop([stepsArb, fc.integer({ min: 1, max: 300 })])(
		'a reset that arrives late hides the same updates',
		(steps, at) => {
			const server = run(steps).reduce((s, u) => fold(s, snapshot(u.update, u.wall)), empty())
			const late = write('plain', at)
			expect(shown(fold(redact(server), late))).toEqual(shown(fold(server, late)))
		},
	)

	propTest.prop([stepsArb, fc.integer({ min: 0, max: 25 })])(
		'joined with a device holding part of the history, in either order',
		(steps, cut) => {
			const updates = run(steps).map((u) => snapshot(u.update, u.wall))
			const server = updates.reduce(fold, empty())
			const device = updates.slice(0, cut).reduce(fold, empty())
			const expected = shown(server)
			expect(shown(joinStates(device, redact(server), schema))).toEqual(expected)
			expect(shown(joinStates(redact(server), device, schema))).toEqual(expected)
		},
	)

	propTest.prop([stepsArb, stepsArb])('later writes land the same', (before, after) => {
		const first = run(before)
		let server = first.reduce((s, u) => fold(s, snapshot(u.update, u.wall)), empty())
		let replica = redact(server)
		// Other devices: a Yjs client id is never reused for different edits.
		for (const u of run(after, 10)) {
			const op = snapshot(u.update, u.wall + 1000)
			server = fold(server, op)
			replica = fold(replica, op)
		}
		expect(shown(replica)).toEqual(shown(server))
	})

	propTest.prop([stepsArb])('redacting twice changes nothing', (steps) => {
		const server = run(steps).reduce((s, u) => fold(s, snapshot(u.update, u.wall)), empty())
		expect(redact(redact(server))).toEqual(redact(server))
	})
})

test('the comparisons above see real text', () => {
	const doc = new Y.Doc()
	doc.getText(TEXT_KEY).insert(0, 'hello')
	const state = fold(empty(), snapshot(Y.encodeStateAsUpdate(doc), 10))
	expect(shown(state)).toEqual([{ insert: 'hello' }])
	expect(shown(redact(state))).toEqual([{ insert: 'hello' }])
})

describe('what a redacted richtext field does not show', () => {
	function editor(): { doc: Y.Doc; text: Y.Text } {
		const doc = new Y.Doc()
		doc.clientID = 1
		const text = doc.getText(TEXT_KEY)
		new Y.UndoManager(text)
		return { doc, text }
	}

	test('text deleted in an editor with undo history is in no update', () => {
		const { doc, text } = editor()
		text.insert(0, 'keep SECRET')
		let state = fold(empty(), snapshot(Y.encodeStateAsUpdate(doc), 10))
		text.delete(5, 6)
		state = fold(state, snapshot(Y.encodeStateAsUpdate(doc), 20))
		expect(updatesText(state).includes('SECRET')).toBe(true)
		expect(updatesText(redact(state)).includes('SECRET')).toBe(false)
		expect(updatesText(redact(state)).includes('keep')).toBe(true)
		expect(Object.keys((redact(state).f.body as { u: object }).u)).toHaveLength(1)
	})

	test('a scope entry carries no deleted text', async () => {
		const { doc, text } = editor()
		text.insert(0, 'keep SECRET')
		let state = fold(empty(), snapshot(Y.encodeStateAsUpdate(doc), 10))
		text.delete(5, 6)
		const current = Y.encodeStateAsUpdate(doc)
		state = fold(state, snapshot(current, 20))
		const entry = await buildScopeEntryOperation({
			trigger: write(null, 30),
			row: { id: 'r', body: current },
			schema,
			timestamp: { wallTime: 30, logical: 0, nodeId: 'n' },
			foldState: state,
			schemaVersion: 1,
		})
		const sent = JSON.parse(entry.foldState as string) as FoldState
		expect(updatesText(sent).includes('SECRET')).toBe(false)
		expect(updatesText(sent).includes('keep')).toBe(true)
	})

	test('a newer update from a device that missed the deletion keeps its text', () => {
		const a = editor()
		a.text.insert(0, 'SECRET')
		const base = Y.encodeStateAsUpdate(a.doc)
		const b = new Y.Doc()
		b.clientID = 2
		Y.applyUpdate(b, base)
		a.text.delete(0, 6)
		let state = fold(empty(), snapshot(Y.encodeStateAsUpdate(a.doc), 10))
		state = fold(state, snapshot(Y.encodeStateAsUpdate(b), 20))
		// A reset stamped 15 must still show b's update, so its text cannot go.
		expect(updatesText(redact(state)).includes('SECRET')).toBe(true)
		const late = write('plain', 15)
		expect(shown(fold(redact(state), late))).toEqual(shown(fold(state, late)))
	})
})
