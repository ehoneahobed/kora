import {
	type CollectionInsertOf,
	type CollectionRecordOf,
	type CollectionUpdateOf,
	type InferInsert,
	type InferRecord,
	type Pluralize,
	type RichtextInput,
	type Singularize,
	type TypedQueryBuilder,
	createApp,
	defineSchema,
	op,
	t,
} from 'korajs'
// Compile-time contract of the schema-typed public API (W11: DX-1, DX-2). Checked by
// `tsc` in `pnpm typecheck`; nothing here runs. Every `@ts-expect-error` is a negative
// case that fails the typecheck if the line compiles.
import { useQuery } from 'korajs/react'
import { expectTypeOf } from 'vitest'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: {
			fields: {
				name: t.string(),
				archived: t.boolean().default(false),
			},
		},
		todos: {
			fields: {
				title: t.string(),
				assignee: t.string().optional(),
				done: t.boolean().default(false),
				priority: t.enum(['low', 'medium', 'high']).default('medium'),
				tags: t.array(t.string()).default([]),
				levels: t.array(t.enum(['low', 'high'])).optional(),
				prefs: t.object({ theme: t.string(), size: t.number() }).optional(),
				meta: t.json<{ source: string }>().optional(),
				notes: t.richtext().optional(),
				dueAt: t.timestamp().optional(),
				projectId: t.string().optional(),
				createdOn: t.timestamp().auto(),
			},
		},
		// Named after a framework property: only reachable as app.collections.events.
		events: {
			fields: { label: t.string() },
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

const app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })

type Todo = CollectionRecordOf<typeof app, 'todos'>
type Project = CollectionRecordOf<typeof app, 'projects'>
type TodoFields = (typeof schema.__input)['collections']['todos']['fields']

// === Records (DX-1) ===
expectTypeOf<Todo>().toEqualTypeOf<InferRecord<TodoFields>>()
expectTypeOf<Todo['id']>().toEqualTypeOf<string>()
expectTypeOf<Todo['createdAt']>().toEqualTypeOf<number>()
expectTypeOf<Todo['title']>().toEqualTypeOf<string>()
expectTypeOf<Todo['assignee']>().toEqualTypeOf<string | null>()
expectTypeOf<Todo['done']>().toEqualTypeOf<boolean | null>()
expectTypeOf<Todo['priority']>().toEqualTypeOf<'low' | 'medium' | 'high' | null>()
expectTypeOf<Todo['tags']>().toEqualTypeOf<string[] | null>()
expectTypeOf<Todo['levels']>().toEqualTypeOf<('low' | 'high')[] | null>()
expectTypeOf<Todo['prefs']>().toEqualTypeOf<{ theme: string; size: number } | null>()
expectTypeOf<Todo['meta']>().toEqualTypeOf<{ source: string } | null>()
expectTypeOf<Todo['notes']>().toEqualTypeOf<Uint8Array | null>()
expectTypeOf<Todo['dueAt']>().toEqualTypeOf<number | null>()
expectTypeOf<Todo['createdOn']>().toEqualTypeOf<number>()
expectTypeOf<Project['name']>().toEqualTypeOf<string>()
expectTypeOf<CollectionInsertOf<typeof app, 'todos'>>().toEqualTypeOf<InferInsert<TodoFields>>()
expectTypeOf<CollectionUpdateOf<typeof app, 'todos'>>().toHaveProperty('title')

// === Collection accessor ===
export async function collectionAccessor(): Promise<void> {
	expectTypeOf(app.todos.findById).returns.resolves.toEqualTypeOf<Todo | null>()
	expectTypeOf(app.todos.insert).returns.resolves.toEqualTypeOf<Todo>()
	expectTypeOf(app.collections.todos.insert).returns.resolves.toEqualTypeOf<Todo>()

	await app.todos.insert({ title: 'x' })
	await app.todos.insert({ title: 'x', notes: 'hello', dueAt: Date.now(), tags: ['a'] })
	await app.todos.insert({ title: 'x', notes: new Uint8Array() satisfies RichtextInput })
	// @ts-expect-error missing required title
	await app.todos.insert({})
	// @ts-expect-error title must be a string
	await app.todos.insert({ title: 1 })
	// @ts-expect-error auto field cannot be set
	await app.todos.insert({ title: 'x', createdOn: 5 })
	// @ts-expect-error insert refuses null; omit the key instead
	await app.todos.insert({ title: 'x', assignee: null })
	// @ts-expect-error timestamps are milliseconds, not Date
	await app.todos.insert({ title: 'x', dueAt: new Date() })
	// @ts-expect-error not an enum member
	await app.todos.insert({ title: 'x', priority: 'urgent' })
	// @ts-expect-error nested object key has the wrong type
	await app.todos.insert({ title: 'x', prefs: { theme: 'dark', size: '12' } })

	await app.todos.update('id', { done: true, assignee: null, tags: op.append('x') })
	// @ts-expect-error a required field cannot be cleared
	await app.todos.update('id', { title: null })
	// @ts-expect-error auto field cannot be updated
	await app.todos.update('id', { createdOn: 1 })
	// @ts-expect-error unknown field
	await app.todos.update('id', { nope: 1 })

	// A collection named after a framework property is not on the app root.
	expectTypeOf(app.events.on).toBeFunction()
	expectTypeOf(app.collections.events.insert).parameter(0).toEqualTypeOf<{ label: string }>()
}

// === Queries (DX-2) ===
export async function queries(): Promise<void> {
	const q = app.todos.where({ done: false })
	expectTypeOf(q).toMatchTypeOf<TypedQueryBuilder<Todo>>()
	expectTypeOf(q.exec).returns.resolves.toEqualTypeOf<Todo[]>()

	app.todos.where({
		title: 'x',
		assignee: null,
		priority: { $in: ['low', 'high'] },
		dueAt: { $gte: 0, $lt: Date.now() },
		createdAt: { $gt: 0 },
		id: { $ne: 'x' },
		prefs: null,
	})
	// @ts-expect-error unknown field in where()
	app.todos.where({ nope: 1 })
	// @ts-expect-error wrong value type in where()
	app.todos.where({ title: 123 })
	// @ts-expect-error not an enum member
	app.todos.where({ priority: { $in: ['urgent'] } })
	// @ts-expect-error $gt only compares numbers and strings
	app.todos.where({ done: { $gt: true } })
	// @ts-expect-error object fields cannot be matched by value
	app.todos.where({ prefs: { theme: 'dark', size: 1 } })
	// @ts-expect-error a required field is never null
	app.todos.where({ title: null })

	app.todos.where({}).orderBy('createdAt', 'desc').orderBy('updatedAt').orderBy('title')
	// @ts-expect-error unknown field in orderBy()
	app.todos.where({}).orderBy('nope')
	// @ts-expect-error invalid direction
	app.todos.where({}).orderBy('title', 'up')

	const withProject = await app.todos.where({}).include('project').exec()
	expectTypeOf(withProject[0]?.project).toEqualTypeOf<Project | null | undefined>()
	expectTypeOf(withProject[0]?.title).toEqualTypeOf<string | undefined>()
	await app.todos.where({}).include('projects').exec()
	// @ts-expect-error unknown relation in include()
	app.todos.where({}).include('nope')
	// After include(), where/orderBy still take the record's own fields (RT-100)...
	const filtered = await app.todos
		.where({})
		.include('project')
		.where({ title: 'x' })
		.orderBy('title')
		.exec()
	expectTypeOf(filtered[0]?.project).toEqualTypeOf<Project | null | undefined>()
	// ...and never the included relation.
	// @ts-expect-error an included relation is not a filterable field
	app.todos.where({}).include('project').where({ project: null })
	// @ts-expect-error an included relation is not a sort key
	app.todos.where({}).include('project').orderBy('project')

	const withTodos = await app.projects.where({}).include('todos').exec()
	expectTypeOf(withTodos[0]?.todos).toEqualTypeOf<Todo[] | undefined>()
	// @ts-expect-error events has no relations
	app.collections.events.where({}).include('todos')

	expectTypeOf(app.todos.where({}).limit(1).offset(1).count).returns.resolves.toBeNumber()
}

// === Bindings accept typed queries ===
export function Component(): void {
	const rows = useQuery(app.todos.where({ done: false }).include('project'))
	expectTypeOf(rows[0]?.project?.name).toEqualTypeOf<string | undefined>()
}

// === Transactions (DX-2) ===
export async function transactions(): Promise<void> {
	await app.transaction(async (tx) => {
		const todo = await tx.todos.insert({ title: 'x' })
		expectTypeOf(todo).toEqualTypeOf<Todo>()
		await tx.todos.update(todo.id, { done: true })
		await tx.events.insert({ label: 'reserved names are fine inside tx' })
		// @ts-expect-error unknown collection on transaction proxy
		await tx.nope.insert({ title: 'x' })
		// @ts-expect-error wrong field type inside a transaction
		await tx.todos.insert({ title: 1 })
	})
	await app.mutation('named', async (tx) => {
		// @ts-expect-error missing required field
		await tx.projects.insert({})
	})
}

// === Singularize / Pluralize mirror the store's runtime rules ===
expectTypeOf<Singularize<'projects'>>().toEqualTypeOf<'project'>()
expectTypeOf<Singularize<'categories'>>().toEqualTypeOf<'category'>()
expectTypeOf<Singularize<'matches'>>().toEqualTypeOf<'match'>()
expectTypeOf<Singularize<'boxes'>>().toEqualTypeOf<'box'>()
expectTypeOf<Singularize<'buses'>>().toEqualTypeOf<'bus'>()
expectTypeOf<Singularize<'class'>>().toEqualTypeOf<'class'>()
expectTypeOf<Singularize<'person'>>().toEqualTypeOf<'person'>()
expectTypeOf<Pluralize<'project'>>().toEqualTypeOf<'projects'>()
expectTypeOf<Pluralize<'category'>>().toEqualTypeOf<'categories'>()
expectTypeOf<Pluralize<'day'>>().toEqualTypeOf<'days'>()
expectTypeOf<Pluralize<'match'>>().toEqualTypeOf<'matches'>()
expectTypeOf<Pluralize<'todos'>>().toEqualTypeOf<'todos'>()
