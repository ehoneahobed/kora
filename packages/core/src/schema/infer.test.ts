import { describe, expectTypeOf, test } from 'vitest'
import { defineSchema } from './define'
import type { InferFieldType, InferInsertInput, InferRecord, InferUpdateInput } from './infer'
import { ArrayFieldBuilder, EnumFieldBuilder, FieldBuilder, t } from './types'

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

	test('richtext field infers to Uint8Array', () => {
		type Result = InferFieldType<FieldBuilder<'richtext', true, false>>
		expectTypeOf<Result>().toEqualTypeOf<Uint8Array>()
	})

	test('enum field infers to literal union', () => {
		type Result = InferFieldType<
			EnumFieldBuilder<readonly ['low', 'medium', 'high'], true, false>
		>
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
		expectTypeOf<Record>().toHaveProperty('assignee').toEqualTypeOf<string | null>()
	})

	test('defaulted fields include null in type', () => {
		const fields = {
			completed: t.boolean().default(false),
		}
		type Record = InferRecord<typeof fields>

		expectTypeOf<Record>().toHaveProperty('completed').toEqualTypeOf<boolean | null>()
	})

	test('enum fields produce literal union', () => {
		const fields = {
			priority: t.enum(['low', 'medium', 'high']),
		}
		type Record = InferRecord<typeof fields>

		expectTypeOf<Record>()
			.toHaveProperty('priority')
			.toEqualTypeOf<'low' | 'medium' | 'high'>()
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
		const fields = {
			title: t.string(),
			count: t.number(),
		}
		type Insert = InferInsertInput<typeof fields>

		expectTypeOf<Insert>().toHaveProperty('title').toEqualTypeOf<string>()
		expectTypeOf<Insert>().toHaveProperty('count').toEqualTypeOf<number>()
	})

	test('optional fields are optional in insert', () => {
		const fields = {
			title: t.string(),
			assignee: t.string().optional(),
		}
		type Insert = InferInsertInput<typeof fields>

		// title is required
		expectTypeOf<Insert>().toHaveProperty('title').toEqualTypeOf<string>()
		// assignee is optional (may or may not be present)
		expectTypeOf<{ title: string; assignee?: string }>().toMatchTypeOf<Insert>()
	})

	test('defaulted fields are optional in insert', () => {
		const fields = {
			title: t.string(),
			completed: t.boolean().default(false),
		}
		type Insert = InferInsertInput<typeof fields>

		expectTypeOf<Insert>().toHaveProperty('title').toEqualTypeOf<string>()
		expectTypeOf<{ title: string }>().toMatchTypeOf<Insert>()
	})

	test('auto fields are excluded from insert', () => {
		const fields = {
			title: t.string(),
			created_at: t.timestamp().auto(),
		}
		type Insert = InferInsertInput<typeof fields>

		expectTypeOf<Insert>().toHaveProperty('title').toEqualTypeOf<string>()
		// Auto fields should not be keys of Insert
		expectTypeOf<Insert>().not.toHaveProperty('created_at')
	})
})

describe('InferUpdateInput', () => {
	test('all non-auto fields are optional in update', () => {
		const fields = {
			title: t.string(),
			count: t.number(),
			created_at: t.timestamp().auto(),
		}
		type Update = InferUpdateInput<typeof fields>

		// Both title and count are optional
		expectTypeOf<{}>().toMatchTypeOf<Update>()
		expectTypeOf<{ title: string }>().toMatchTypeOf<Update>()
		expectTypeOf<{ count: number }>().toMatchTypeOf<Update>()
		// Auto fields should not be present
		expectTypeOf<Update>().not.toHaveProperty('created_at')
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
