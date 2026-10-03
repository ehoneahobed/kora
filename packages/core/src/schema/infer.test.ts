import { describe, expect, expectTypeOf, test } from 'vitest'
import type { AtomicOpSentinel } from '../operations/atomic-ops'
import { op } from '../operations/atomic-ops'
import type { BlobRef } from '../types'
import { defineSchema } from './define'
import type {
	InferFieldInput,
	InferFieldType,
	InferInsert,
	InferInsertInput,
	InferRecord,
	InferUpdate,
	InferUpdateInput,
} from './infer'
import type { FieldBuilder, RichtextInput } from './types'
import { t } from './types'

// These tests are compile-time assertions (checked by `tsc` in `pnpm typecheck`). Every
// `@ts-expect-error` is a negative case: it fails the typecheck if the line compiles.

describe('field builders are structurally distinct (DX-1)', () => {
	test('required, optional, defaulted and auto builders are different types', () => {
		expectTypeOf(t.string()).not.toEqualTypeOf(t.string().optional())
		expectTypeOf(t.string()).not.toEqualTypeOf(t.string().auto())
		expectTypeOf(t.string().optional()).not.toEqualTypeOf(t.string().auto())
		expectTypeOf(t.string()).not.toEqualTypeOf(t.number())
	})

	test('an optional builder is not assignable to a required one', () => {
		const required: FieldBuilder<'string', true, false> = t.string()
		// @ts-expect-error optional is not required
		const notRequired: FieldBuilder<'string', true, false> = t.string().optional()
		// @ts-expect-error auto is not non-auto
		const notAuto: FieldBuilder<'timestamp', false, false> = t.timestamp().auto()
		expect([required, notRequired, notAuto]).toHaveLength(3)
	})

	test('a bare FieldBuilder accepts every builder', () => {
		const all: FieldBuilder[] = [
			t.string(),
			t.string().optional(),
			t.timestamp().auto(),
			t.enum(['a']).default('a'),
			t.array(t.number()),
			t.object({ a: t.string() }),
			t.json<{ x: number }>(),
			t.secret().hashed(),
			t.blob().optional(),
		]
		expect(all).toHaveLength(9)
	})

	test('the brand is type-only (not present at runtime)', () => {
		expect('~field' in t.string()).toBe(false)
	})
})

describe('InferFieldType', () => {
	test('scalar kinds', () => {
		expectTypeOf<InferFieldType<ReturnType<typeof t.string>>>().toEqualTypeOf<string>()
		expectTypeOf<InferFieldType<ReturnType<typeof t.number>>>().toEqualTypeOf<number>()
		expectTypeOf<InferFieldType<ReturnType<typeof t.boolean>>>().toEqualTypeOf<boolean>()
		expectTypeOf<InferFieldType<ReturnType<typeof t.timestamp>>>().toEqualTypeOf<number>()
		expectTypeOf<InferFieldType<ReturnType<typeof t.richtext>>>().toEqualTypeOf<Uint8Array>()
		expectTypeOf<InferFieldType<ReturnType<typeof t.blob>>>().toEqualTypeOf<BlobRef>()
		expectTypeOf<InferFieldType<ReturnType<typeof t.secret>>>().toEqualTypeOf<string>()
	})

	test('explicit FieldBuilder<Kind> falls back to the kind type', () => {
		expectTypeOf<InferFieldType<FieldBuilder<'string', true, false>>>().toEqualTypeOf<string>()
		expectTypeOf<InferFieldType<FieldBuilder<'timestamp'>>>().toEqualTypeOf<number>()
	})

	test('enum infers its literal union', () => {
		const f = t.enum(['low', 'medium', 'high'])
		expectTypeOf<InferFieldType<typeof f>>().toEqualTypeOf<'low' | 'medium' | 'high'>()
	})

	test('array carries its item type, including enum literals', () => {
		const strings = t.array(t.string())
		const levels = t.array(t.enum(['low', 'high']))
		expectTypeOf<InferFieldType<typeof strings>>().toEqualTypeOf<string[]>()
		expectTypeOf<InferFieldType<typeof levels>>().toEqualTypeOf<('low' | 'high')[]>()
	})

	test('object carries its nested shape', () => {
		const prefs = t.object({
			theme: t.string(),
			size: t.number(),
			mode: t.enum(['a', 'b']).optional(),
		})
		expectTypeOf<InferFieldType<typeof prefs>>().toEqualTypeOf<{
			theme: string
			size: number
			mode?: 'a' | 'b' | null
		}>()
	})

	test('json carries T', () => {
		const meta = t.json<{ source: string }>()
		expectTypeOf<InferFieldType<typeof meta>>().toEqualTypeOf<{ source: string }>()
		expectTypeOf<InferFieldType<ReturnType<typeof t.json>>>().toEqualTypeOf<unknown>()
	})

	test('modifiers keep the value type', () => {
		const f = t.enum(['x', 'y']).optional().merge('lww')
		expectTypeOf<InferFieldType<typeof f>>().toEqualTypeOf<'x' | 'y'>()
	})

	test('compiled descriptors infer structurally', () => {
		expectTypeOf<InferFieldType<{ kind: 'number' }>>().toEqualTypeOf<number>()
		expectTypeOf<InferFieldType<{ kind: 'enum'; enumValues: readonly ['a', 'b'] }>>().toEqualTypeOf<
			'a' | 'b'
		>()
		expectTypeOf<InferFieldType<{ kind: 'array'; itemKind: 'string' }>>().toEqualTypeOf<string[]>()
	})

	test('richtext input accepts strings and bytes', () => {
		expectTypeOf<InferFieldInput<ReturnType<typeof t.richtext>>>().toEqualTypeOf<RichtextInput>()
		expectTypeOf<InferFieldInput<ReturnType<typeof t.string>>>().toEqualTypeOf<string>()
	})
})

describe('default() is typed by the field (DX-2)', () => {
	test('accepts values of the field type', () => {
		expect(t.number().default(1)._build().defaultValue).toBe(1)
		expect(t.enum(['a', 'b']).default('b')._build().defaultValue).toBe('b')
		expect(t.array(t.string()).default([])._build().defaultValue).toEqual([])
		expect(t.object({ a: t.number() }).default({ a: 1 })._build().defaultValue).toEqual({ a: 1 })
		expect(t.json<{ n: number }>().default({ n: 1 })._build().defaultValue).toEqual({ n: 1 })
		expect(t.richtext().default('hello')._build().defaultValue).toBe('hello')
	})

	test('refuses values of another type', () => {
		// @ts-expect-error number field, string default
		t.number().default('not a number')
		// @ts-expect-error string field, number default
		t.string().default(1)
		// @ts-expect-error not an enum member
		t.enum(['a', 'b']).default('c')
		// @ts-expect-error array of strings, number item
		t.array(t.string()).default([1])
		// @ts-expect-error object key has the wrong type
		t.object({ a: t.number() }).default({ a: 'x' })
		// @ts-expect-error timestamp is milliseconds, not a Date
		t.timestamp().default(new Date())
	})

	test('secret().default() keeps the secret builder (and its mode)', () => {
		const desc = t.secret().hashed().default('x')._build()
		expect(desc.kind).toBe('secret')
		expect(desc.secretMode).toBe('hashed')
	})
})

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				count: t.number(),
				assignee: t.string().optional(),
				done: t.boolean().default(false),
				priority: t.enum(['low', 'high']).default('low'),
				tags: t.array(t.string()).default([]),
				prefs: t.object({ theme: t.string() }).optional(),
				notes: t.richtext().optional(),
				createdOn: t.timestamp().auto(),
				code: t.string().auto(),
			},
		},
	},
})
type Fields = (typeof schema.__input)['collections']['items']['fields']

describe('InferRecord', () => {
	type Item = InferRecord<Fields>

	test('has metadata fields', () => {
		expectTypeOf<Item['id']>().toEqualTypeOf<string>()
		expectTypeOf<Item['createdAt']>().toEqualTypeOf<number>()
		expectTypeOf<Item['updatedAt']>().toEqualTypeOf<number>()
	})

	test('required fields are non-null; optional and defaulted fields are nullable', () => {
		expectTypeOf<Item['title']>().toEqualTypeOf<string>()
		expectTypeOf<Item['count']>().toEqualTypeOf<number>()
		expectTypeOf<Item['assignee']>().toEqualTypeOf<string | null>()
		expectTypeOf<Item['done']>().toEqualTypeOf<boolean | null>()
		expectTypeOf<Item['priority']>().toEqualTypeOf<'low' | 'high' | null>()
		expectTypeOf<Item['tags']>().toEqualTypeOf<string[] | null>()
		expectTypeOf<Item['prefs']>().toEqualTypeOf<{ theme: string } | null>()
		expectTypeOf<Item['notes']>().toEqualTypeOf<Uint8Array | null>()
	})

	test('auto timestamps are always set; other auto kinds are nullable', () => {
		expectTypeOf<Item['createdOn']>().toEqualTypeOf<number>()
		expectTypeOf<Item['code']>().toEqualTypeOf<string | null>()
	})

	test('records are readonly and have exactly the schema keys plus metadata', () => {
		expectTypeOf<keyof Item>().toEqualTypeOf<
			| 'id'
			| 'createdAt'
			| 'updatedAt'
			| 'title'
			| 'count'
			| 'assignee'
			| 'done'
			| 'priority'
			| 'tags'
			| 'prefs'
			| 'notes'
			| 'createdOn'
			| 'code'
		>()
	})
})

describe('InferInsertInput', () => {
	type Insert = InferInsertInput<Fields>

	test('required fields are required, optional and defaulted optional, auto excluded', () => {
		expectTypeOf<Insert>().toEqualTypeOf<{
			title: string
			count: number
			assignee?: string
			done?: boolean
			priority?: 'low' | 'high'
			tags?: string[]
			prefs?: { theme: string }
			notes?: RichtextInput
		}>()
		expectTypeOf<InferInsert<Fields>>().toEqualTypeOf<Insert>()
	})

	test('negative cases', () => {
		const ok: Insert = { title: 'x', count: 1 }
		// @ts-expect-error missing required title
		const missing: Insert = { count: 1 }
		// @ts-expect-error wrong type
		const wrong: Insert = { title: 1, count: 1 }
		// @ts-expect-error auto fields cannot be set
		const auto: Insert = { title: 'x', count: 1, createdOn: 5 }
		// @ts-expect-error insert refuses null (omit the key instead)
		const nulled: Insert = { title: 'x', count: 1, assignee: null }
		// @ts-expect-error unknown field
		const unknownKey: Insert = { title: 'x', count: 1, nope: true }
		expect([ok, missing, wrong, auto, nulled, unknownKey]).toHaveLength(6)
	})
})

describe('InferUpdateInput', () => {
	type Update = InferUpdateInput<Fields>

	test('every writable field is optional; nullable fields accept null; atomic ops where valid', () => {
		expectTypeOf<Update>().toEqualTypeOf<{
			title?: string
			count?: number | AtomicOpSentinel
			assignee?: string | null
			done?: boolean | null
			priority?: 'low' | 'high' | null
			tags?: string[] | null | AtomicOpSentinel
			prefs?: { theme: string } | null
			notes?: RichtextInput | null
		}>()
		expectTypeOf<InferUpdate<Fields>>().toEqualTypeOf<Update>()
	})

	test('negative cases', () => {
		const ok: Update = { count: op.increment(1), tags: op.append('x'), assignee: null }
		// @ts-expect-error a required field cannot be cleared
		const clearRequired: Update = { title: null }
		// @ts-expect-error auto fields cannot be updated
		const auto: Update = { createdOn: 1 }
		// @ts-expect-error atomic ops only on number, timestamp and array fields
		const atomicOnString: Update = { title: op.increment(1) }
		expect([ok, clearRequired, auto, atomicOnString]).toHaveLength(4)
	})
})

describe('defineSchema preserves type information', () => {
	test('TypedSchemaDefinition has __input brand', () => {
		expectTypeOf(schema).toHaveProperty('__input')
		expectTypeOf(schema).toHaveProperty('version')
		expectTypeOf(schema).toHaveProperty('collections')
		expectTypeOf(schema).toHaveProperty('relations')
	})
})
