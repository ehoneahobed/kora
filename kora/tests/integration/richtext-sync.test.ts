import { defineSchema, t } from '@korajs/core'
import { mergeRichtext, richtextToString, stringToRichtextUpdate } from '@korajs/merge'
import { createTestNetwork } from '@korajs/test'
import { afterEach, describe, expect, test } from 'vitest'

const notesSchema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				body: t.richtext(),
			},
		},
	},
})

describe('richtext sync convergence', () => {
	let network: Awaited<ReturnType<typeof createTestNetwork>> | null = null

	afterEach(async () => {
		if (network) {
			await network.close()
			network = null
		}
	})

	test('syncs richtext inserts between devices', async () => {
		network = await createTestNetwork(notesSchema, { devices: 2 })
		const deviceA = network.devices[0]
		const deviceB = network.devices[1]
		if (!deviceA || !deviceB) {
			throw new Error('expected two devices')
		}

		const note = await deviceA.collection('notes').insert({
			title: 'Note',
			body: 'Hello world',
		})
		await deviceA.sync()
		await deviceB.sync()

		const record = await deviceB.collection('notes').findById(note.id)
		expect(richtextToString(record?.body as Parameters<typeof richtextToString>[0])).toBe(
			'Hello world',
		)
	})

	test('Yjs merge combines concurrent append-style richtext edits', () => {
		const base = stringToRichtextUpdate('Hi')
		const local = mergeRichtext(stringToRichtextUpdate('HiA'), base, base)
		const remote = mergeRichtext(stringToRichtextUpdate('HiB'), base, base)
		const merged = mergeRichtext(local, remote, base)
		const text = richtextToString(merged)

		expect(text).toContain('Hi')
		expect(text).toContain('A')
		expect(text).toContain('B')
	})
})
