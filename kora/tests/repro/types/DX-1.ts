// DX-1 tsc probe. Correct typing => this file compiles with ZERO errors.
// Today: each "@ts-expect-error" below is UNUSED (tsc error TS2578) and the
// Equal<> checks fail, because FieldBuilder's Req/Auto params are phantom
// (never used structurally), so every builder is assignable to every
// FieldBuilder<K, true|false, true|false> and InferInsertInput/InferRecord
// conditionals collapse.
// Run: npx tsc --noEmit --strict --skipLibCheck --module esnext --moduleResolution bundler --target es2022 tests/repro/types/DX-1.ts
import { createApp, defineSchema, t } from 'korajs'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
	? true
	: false
const assertTrue = <T extends true>(): T => true as T

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				assignee: t.string().optional(),
				done: t.boolean().default(false),
				createdOn: t.timestamp().auto(),
			},
		},
	},
})

const app = createApp({ schema })
type Todo = NonNullable<Awaited<ReturnType<typeof app.todos.findById>>>

export async function probe(): Promise<void> {
	// @ts-expect-error missing required `title`
	await app.todos.insert({})
	// @ts-expect-error `title` must be a string
	await app.todos.insert({ title: 1 })
	// @ts-expect-error auto field must not be settable
	await app.todos.insert({ title: 'x', createdOn: 5 })
	// valid: optional/defaulted keys may be omitted
	await app.todos.insert({ title: 'x' })

	assertTrue<Equal<Todo['assignee'], string | null>>()
	assertTrue<Equal<Todo['done'], boolean | null>>()
	assertTrue<Equal<Todo['title'], string>>()
}
