import { describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { createRichTextController } from './create-richtext-controller'

function encodeText(value: string): Uint8Array {
	const doc = new Y.Doc()
	doc.getText('content').insert(0, value)
	return Y.encodeStateAsUpdate(doc)
}

describe('createRichTextController', () => {
	test('loads a record richtext field into Y.Text', async () => {
		const hello = encodeText('Hello')
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: hello })),
			update: vi.fn(async () => ({ id: 'rec-1' })),
			where: vi.fn(() => ({
				subscribe: (callback: (results: Array<Record<string, unknown>>) => void) => {
					callback([{ id: 'rec-1', body: hello }])
					return () => {}
				},
			})),
		}

		const controller = createRichTextController({
			collection: notes as never,
			collectionName: 'notes',
			recordId: 'rec-1',
			fieldName: 'body',
			store: { collection: () => notes as never },
		})

		await vi.waitFor(() => {
			expect(controller.getSnapshot().ready).toBe(true)
		})

		expect(controller.text.toString()).toBe('Hello')
		controller.destroy()
	})
})

interface Harness {
	notes: {
		findById: ReturnType<typeof vi.fn>
		update: ReturnType<typeof vi.fn>
		where: ReturnType<typeof vi.fn>
	}
	/** Simulate the local store reporting a new stored value for the record. */
	storeChanged: (body: Uint8Array) => void
	/** Every value the controller asked the store to save, in order. */
	saved: Uint8Array[]
	failNextSaves: (count: number, message?: string) => void
}

function harness(initial: Uint8Array): Harness {
	let listener: ((results: Array<Record<string, unknown>>) => void) | null = null
	const saved: Uint8Array[] = []
	let failures = 0
	let failureMessage = 'refused'
	const notes = {
		findById: vi.fn(async () => ({ id: 'rec-1', body: initial })),
		update: vi.fn(async (_id: string, data: Record<string, unknown>) => {
			if (failures > 0) {
				failures -= 1
				throw new Error(failureMessage)
			}
			saved.push(data.body as Uint8Array)
			return { id: 'rec-1' }
		}),
		where: vi.fn(() => ({
			subscribe: (callback: (results: Array<Record<string, unknown>>) => void) => {
				listener = callback
				callback([{ id: 'rec-1', body: initial }])
				return () => {
					listener = null
				}
			},
		})),
	}
	return {
		notes,
		saved,
		storeChanged: (body) => listener?.([{ id: 'rec-1', body }]),
		failNextSaves: (count, message = 'refused') => {
			failures = count
			failureMessage = message
		},
	}
}

function textOf(update: Uint8Array | undefined): string {
	const doc = new Y.Doc()
	if (update) Y.applyUpdate(doc, update)
	return doc.getText('content').toString()
}

/** A collaborator's saved state: the base plus their own edit, without ours. */
function collaboratorState(base: Uint8Array, insertAt: number, value: string): Uint8Array {
	const doc = new Y.Doc()
	Y.applyUpdate(doc, base)
	doc.getText('content').insert(insertAt, value)
	return Y.encodeStateAsUpdate(doc)
}

function docChannelEngine() {
	return {
		getRichtextDocChannel: () => ({
			shouldUseChannel: () => true,
			send: vi.fn(),
			subscribe: () => () => {},
		}),
		getAwarenessManager: () => ({
			clientId: 1,
			getLocalState: () => null,
			setLocalState: () => {},
			getStates: () => new Map(),
			on: () => () => {},
		}),
	}
}

async function open(h: Harness, withDocChannel: boolean) {
	const controller = createRichTextController({
		collection: h.notes as never,
		collectionName: 'notes',
		recordId: 'rec-1',
		fieldName: 'body',
		store: { collection: () => h.notes as never },
		...(withDocChannel ? { syncEngine: docChannelEngine() as never } : {}),
	})
	await vi.waitFor(() => expect(controller.getSnapshot().ready).toBe(true))
	return controller
}

describe('createRichTextController never loses local edits', () => {
	test('a stored change during the save debounce does not drop the waiting edits', async () => {
		vi.useFakeTimers()
		try {
			const base = encodeText('Hello')
			const h = harness(base)
			const controller = await open(h, true)
			controller.text.insert(5, ' world')
			// Before the debounced save runs, a collaborator's save reaches the store.
			h.storeChanged(collaboratorState(base, 0, '> '))
			await vi.advanceTimersByTimeAsync(1_000)
			expect(controller.text.toString()).toBe('> Hello world')
			expect(textOf(h.saved.at(-1))).toBe('> Hello world')
			controller.destroy()
		} finally {
			vi.useRealTimers()
		}
	})

	test('a refused save is retried with the next edit, even after a stored change', async () => {
		const base = encodeText('Hello')
		const h = harness(base)
		const controller = await open(h, false)
		h.failNextSaves(1, 'OPERATION_TOO_LARGE')
		controller.text.insert(5, ' world')
		await vi.waitFor(() =>
			expect(controller.getSnapshot().error?.message).toBe('OPERATION_TOO_LARGE'),
		)
		expect(controller.getSnapshot().hasUnsavedChanges).toBe(true)
		expect(textOf(controller.getUnsavedState() ?? undefined)).toBe('Hello world')

		h.storeChanged(collaboratorState(base, 0, '> '))
		controller.text.insert(controller.text.length, '!')
		await vi.waitFor(() => expect(textOf(h.saved.at(-1))).toBe('> Hello world!'))
		await vi.waitFor(() => expect(controller.getSnapshot().error).toBeNull())
		expect(controller.getSnapshot().hasUnsavedChanges).toBe(false)
		expect(controller.getUnsavedState()).toBeNull()
		controller.destroy()
	})

	test('retrySave saves refused content without a new edit and clears the error', async () => {
		const h = harness(encodeText('Hello'))
		const controller = await open(h, false)
		h.failNextSaves(1)
		controller.text.insert(5, ' again')
		await vi.waitFor(() => expect(controller.getSnapshot().error).not.toBeNull())
		expect(h.saved).toHaveLength(0)
		await controller.retrySave()
		expect(textOf(h.saved.at(-1))).toBe('Hello again')
		expect(controller.getSnapshot().error).toBeNull()
		expect(controller.getSnapshot().hasUnsavedChanges).toBe(false)
		controller.destroy()
	})

	test('destroying during the save debounce still saves the waiting edits', async () => {
		vi.useFakeTimers()
		try {
			const h = harness(encodeText('Hello'))
			const controller = await open(h, true)
			controller.text.insert(5, ' bye')
			controller.destroy()
			await vi.advanceTimersByTimeAsync(1_000)
			expect(textOf(h.saved.at(-1))).toBe('Hello bye')
		} finally {
			vi.useRealTimers()
		}
	})

	test('concurrent saves are serialized and the last one holds every edit', async () => {
		const h = harness(encodeText(''))
		const controller = await open(h, false)
		for (const ch of 'abcdef') controller.text.insert(controller.text.length, ch)
		await vi.waitFor(() => expect(textOf(h.saved.at(-1))).toBe('abcdef'))
		expect(h.saved.length).toBeLessThanOrEqual(6)
		expect(controller.getSnapshot().hasUnsavedChanges).toBe(false)
		controller.destroy()
	})
})
