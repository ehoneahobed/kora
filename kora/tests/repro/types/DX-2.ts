// DX-2 tsc probe. Correct typing => ZERO errors. Today every
// "@ts-expect-error" is unused (TS2578) and Equal<> checks fail.
// Run: npx tsc --noEmit --strict --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --jsx react-jsx tests/repro/types/DX-2.ts
import { createApp, defineSchema, t } from 'korajs'
import { useCollection } from 'korajs/react'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertTrue = <T extends true>(): T => true as T

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				prefs: t.object({ theme: t.string(), size: t.number() }),
				levels: t.array(t.enum(['low', 'high'])),
				// @ts-expect-error default value must match the field kind
				count: t.number().default('not a number'),
			},
		},
	},
})

const app = createApp({ schema })
type Todo = NonNullable<Awaited<ReturnType<typeof app.todos.findById>>>

export async function probe(): Promise<void> {
	assertTrue<Equal<Todo['prefs'], { theme: string; size: number }>>()
	assertTrue<Equal<Todo['levels'], ('low' | 'high')[]>>()

	// @ts-expect-error unknown field in where()
	app.todos.where({ nope: 1 })
	// @ts-expect-error wrong value type in where()
	app.todos.where({ title: 123 })
	// @ts-expect-error unknown field in orderBy()
	app.todos.where({}).orderBy('nope')
	// @ts-expect-error unknown relation in include()
	app.todos.where({}).include('nope')

	await app.transaction(async (tx) => {
		// @ts-expect-error unknown collection on transaction proxy
		await tx.nope.insert({ title: 'x' })
		// @ts-expect-error wrong field type inside a transaction
		await tx.todos.insert({ title: 1 })
	})
}

export function Hook(): void {
	const todos = useCollection('todos')
	// @ts-expect-error useCollection should be typed by schema (title is string)
	void todos.insert({ title: 1 })
}
