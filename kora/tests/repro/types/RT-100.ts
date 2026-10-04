// RT-100 tsc probe (final RC red team, W11). Correct typing => ZERO errors: each
// "@ts-expect-error" marks a call the runtime refuses (or silently misreads) that the
// typed API must reject at compile time. Today the marked lines compile (TS2578).
// Run: npx tsc --noEmit --strict --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --jsx react-jsx tests/repro/types/RT-100.ts
import { createApp, defineSchema, t } from 'korajs'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: {
			fields: {
				title: t.string(),
				projectId: t.string().optional(),
				notes: t.richtext(),
				createdOn: t.timestamp().auto(),
			},
		},
	},
	relations: {
		todoProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'set-null',
		},
	},
})

const app = createApp({ schema })

export async function probe(): Promise<void> {
	const withProject = app.todos.where({}).include('project')
	// Runtime: QueryError "Unknown field project" (an included relation is not a column).
	// @ts-expect-error an included relation is not a filterable field
	withProject.where({ project: null })
	// Runtime: QueryError, orderBy on a relation property.
	// @ts-expect-error an included relation is not a sort key
	withProject.orderBy('project')
	// Runtime: the auto field is set by Kora; a provided value is refused.
	// @ts-expect-error auto fields are not insertable
	await app.todos.insert({ title: 'x', createdOn: 1 })
	// @ts-expect-error auto fields are not updatable
	await app.todos.update('id', { createdOn: 2 })
	// @ts-expect-error id is not updatable
	await app.todos.update('id', { id: 'other' })
}
