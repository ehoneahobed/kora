import { AppNotReadyError, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

/**
 * DX-4: before app.ready, insert/update/delete/where throw AppNotReadyError
 * but findById silently returns null (kora/src/collection-accessor.ts:25-27),
 * which is indistinguishable from "record does not exist".
 * Correct: findById rejects with AppNotReadyError like the other methods.
 */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

describe('DX-4 findById before ready', () => {
	let app: KoraApp | null = null
	afterEach(async () => {
		await app?.ready.catch(() => {})
		await app?.close()
		app = null
	})

	test('rejects with AppNotReadyError (consistent with insert)', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		const todos = (app as unknown as Record<string, any>).todos
		await expect(todos.insert({ title: 'x' })).rejects.toBeInstanceOf(AppNotReadyError)
		await expect(todos.findById('some-id')).rejects.toBeInstanceOf(AppNotReadyError)
	})
})
