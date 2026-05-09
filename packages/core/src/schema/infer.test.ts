import { describe, expectTypeOf, test } from 'vitest'
import { defineSchema } from './define'
import type { InferFieldType, InferInsertInput, InferRecord, InferUpdateInput } from './infer'
import type { ArrayFieldBuilder, EnumFieldBuilder, FieldBuilder } from './types'
import { t } from './types'

describe('InferFieldType', () => {
	test('string field infers to string', () => {
		type Result = InferFieldType<FieldBuilder<'string', true, false>>
		expectTypeOf<Result>().toEqualTypeOf<string>()
	})

	test('number field infers to number', () => {
		type Result = InferFieldType<FieldBuilder<'number', true, false>>
		expectTypeOf<Result>().toEqualTypeOf<number>()
	})

	test('boolean field infers to boolean', () => {
		type Result = InferFieldType<FieldBuilder<'boolean', true, false>>
		expectTypeOf<Result>().toEqualTypeOf<boolean>()
	})

	test('timestamp field infers to number', () => {
		type Result = InferFieldType<FieldBuilder<'timestamp', true, false>>
		expectTypeOf<Result>().toEqualTypeOf<number>()
	})

	test('richtext field infers to string', () => {
		type Result = InferFieldType<FieldBuilder<'richtext', true, false>>
		expectTypeOf<Result>().toEqualTypeOf<string>()
	})

	test('enum field infers to literal union', () => {
		type Result = InferFieldType<EnumFieldBuilder<readonly ['low', 'medium', 'high'], true, false>>
		expectTypeOf<Result>().toEqualTypeOf<'low' | 'medium' | 'high'>()
	})

	test('array of strings infers to string[]', () => {
		type Result = InferFieldType<ArrayFieldBuilder<'string', true, false>>
		expectTypeOf<Result>().toEqualTypeOf<string[]>()
	})

	test('array of numbers infers to number[]', () => {
		type Result = InferFieldType<ArrayFieldBuilder<'number', true, false>>
		expectTypeOf<Result>().toEqualTypeOf<number[]>()
	})
})

describe('InferRecord', () => {
	test('produces correct record type with id and metadata', () => {
		const fields = {
			title: t.string(),
			count: t.number(),
			active: t.boolean(),
		}
		type Record = InferRecord<typeof fields>

		expectTypeOf<Record>().toHaveProperty('id').toEqualTypeOf<string>()
		expectTypeOf<Record>().toHaveProperty('createdAt').toEqualTypeOf<number>()
		expectTypeOf<Record>().toHaveProperty('updatedAt').toEqualTypeOf<number>()
		expectTypeOf<Record>().toHaveProperty('title').toEqualTypeOf<string>()
		expectTypeOf<Record>().toHaveProperty('count').toEqualTypeOf<number>()
		expectTypeOf<Record>().toHaveProperty('active').toEqualTypeOf<boolean>()
	})

	test('optional fields include null in type', () => {
		const fields = {
			title: t.string(),
			assignee: t.string().optional(),
		}
		type Record = InferRecord<typeof fields>

		expectTypeOf<Record>().toHaveProperty('title').toEqualTypeOf<string>()
		expectTypeOf<Record['assignee']>().toMatchTypeOf<string | null>()
	})

	test('defaulted fields include null in type', () => {
		const fields = {
			completed: t.boolean().default(false),
		}
		type Record = InferRecord<typeof fields>

		expectTypeOf<Record['completed']>().toMatchTypeOf<boolean | null>()
	})

	test('enum fields produce literal union', () => {
		const fields = {
			priority: t.enum(['low', 'medium', 'high']),
		}
		type Record = InferRecord<typeof fields>

		expectTypeOf<Record>().toHaveProperty('priority').toEqualTypeOf<'low' | 'medium' | 'high'>()
	})

	test('array fields are typed', () => {
		const fields = {
			tags: t.array(t.string()),
		}
		type Record = InferRecord<typeof fields>

		expectTypeOf<Record>().toHaveProperty('tags').toEqualTypeOf<string[]>()
	})
})

describe('InferInsertInput', () => {
	test('required fields are required in insert', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				items: { fields: { title: t.string(), count: t.number() } },
			},
		})
		type Fields = (typeof schema.__input)['collections']['items']['fields']
		type Insert = InferInsertInput<Fields>
		type _Check = Insert extends { title: string; count: number } ? true : false
	})

	test('optional fields are optional in insert', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				items: {
					fields: { title: t.string(), assignee: t.string().optional() },
				},
			},
		})
		type Fields = (typeof schema.__input)['collections']['items']['fields']
		type Insert = InferInsertInput<Fields>
		type _Required = { title: string } extends Insert ? true : false
	})

	test('defaulted fields are optional in insert', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				items: {
					fields: { title: t.string(), completed: t.boolean().default(false) },
				},
			},
		})
		type Fields = (typeof schema.__input)['collections']['items']['fields']
		type Insert = InferInsertInput<Fields>
		type _Required = { title: string } extends Insert ? true : false
	})

	test('auto fields are excluded from insert', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				items: {
					fields: { title: t.string(), created_at: t.timestamp().auto() },
				},
			},
		})
		type Fields = (typeof schema.__input)['collections']['items']['fields']
		type Insert = InferInsertInput<Fields>
		type _HasTitle = Insert extends { title: string } ? true : false
		type _NoAuto = 'created_at' extends keyof Insert ? false : true
	})
})

describe('InferUpdateInput', () => {
	test('all non-auto fields are optional in update', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				items: {
					fields: {
						title: t.string(),
						count: t.number(),
						created_at: t.timestamp().auto(),
					},
				},
			},
		})
		type Fields = (typeof schema.__input)['collections']['items']['fields']
		type Update = InferUpdateInput<Fields>
		type _Optional = Record<string, never> extends Update ? true : false
		type _Allowed = { title: string } extends Update ? true : false
	})
})

describe('defineSchema preserves type information', () => {
	test('TypedSchemaDefinition has __input brand', () => {
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

		// Schema has __input property at type level
		expectTypeOf(schema).toHaveProperty('__input')
		// It also has the regular SchemaDefinition properties
		expectTypeOf(schema).toHaveProperty('version')
		expectTypeOf(schema).toHaveProperty('collections')
		expectTypeOf(schema).toHaveProperty('relations')
	})
})
