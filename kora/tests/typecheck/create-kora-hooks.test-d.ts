import { defineSchema, t } from '@korajs/core'
import { createKoraHooks } from 'korajs/react'
import { describe, expectTypeOf, test } from 'vitest'
import type { createApp } from '../../src/create-app'

// createKoraHooks<typeof app>() against the real types createApp infers: whatever the
// schema types infer for records, inserts and updates flows through unchanged.
const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

declare const app: ReturnType<typeof createApp<typeof schema.__input>>
const hooks = createKoraHooks<typeof app>()

describe('createKoraHooks<typeof app>()', () => {
	test('useCollection is the typed accessor createApp exposes', () => {
		expectTypeOf(hooks.useCollection<'todos'>).returns.toEqualTypeOf<
			(typeof app)['collections']['todos']
		>()
		// @ts-expect-error not a collection of this schema
		hooks.useCollection('todoz')
	})

	test('useQuery rows are the collection record type', () => {
		const todos = hooks.useCollection('todos')
		const rows = hooks.useQuery(todos.where({ completed: false }))
		expectTypeOf(rows[0]?.title).toEqualTypeOf<string | undefined>()
	})
})
