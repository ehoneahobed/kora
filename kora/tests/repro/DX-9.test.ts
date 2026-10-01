import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

/**
 * DX-9: a collection whose name collides with a framework property
 * (`events`, `sync`, `ready`, ...) is silently skipped as a direct accessor:
 * untyped/JS callers doing app.events.insert(...) hit the event emitter.
 * Correct: createApp surfaces the collision (dev warning or validation error
 * naming the collection and pointing to app.collections.<name>).
 */
const schema = defineSchema({
	version: 1,
	collections: {
		events: { fields: { title: t.string() } },
		sync: { fields: { title: t.string() } },
	},
})

describe('DX-9 reserved collection names are surfaced, not silently shadowed', () => {
	let app: KoraApp | null = null
	afterEach(async () => {
		await app?.close()
		app = null
		vi.restoreAllMocks()
	})

	test('createApp warns or throws for `events` / `sync` collections', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		let threw: unknown = null
		try {
			app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
			await app.ready
		} catch (e) {
			threw = e
		}
		const warned = warn.mock.calls.some((args) => /events|sync/.test(String(args[0])))
		const thrownNamesIt = threw instanceof Error && /events|sync/.test(threw.message)
		expect(warned || thrownNamesIt).toBe(true)
		// The direct accessor today is the event emitter, not the collection:
		if (app) expect(typeof (app.events as { insert?: unknown }).insert).toBe('undefined')
	})
})
