import { describe, expect, test } from 'vitest'
import { ArrayFieldBuilder, EnumFieldBuilder, FieldBuilder, t } from './types'

describe('FieldBuilder', () => {
	test('t.string() creates a required string field', () => {
		const desc = t.string()._build()
		expect(desc.kind).toBe('string')
		expect(desc.required).toBe(true)
		expect(desc.defaultValue).toBeUndefined()
		expect(desc.auto).toBe(false)
		expect(desc.enumValues).toBeNull()
		expect(desc.itemKind).toBeNull()
	})

	test('t.number() creates a required number field', () => {
		const desc = t.number()._build()
		expect(desc.kind).toBe('number')
		expect(desc.required).toBe(true)
	})

	test('t.boolean() creates a required boolean field', () => {
		const desc = t.boolean()._build()
		expect(desc.kind).toBe('boolean')
		expect(desc.required).toBe(true)
	})

	test('t.timestamp() creates a required timestamp field', () => {
		const desc = t.timestamp()._build()
		expect(desc.kind).toBe('timestamp')
		expect(desc.required).toBe(true)
	})

	test('t.richtext() creates a required richtext field', () => {
		const desc = t.richtext()._build()
		expect(desc.kind).toBe('richtext')
		expect(desc.required).toBe(true)
	})

	test('.optional() makes the field not required', () => {
		const desc = t.string().optional()._build()
		expect(desc.required).toBe(false)
		expect(desc.defaultValue).toBeUndefined()
	})

	test('.default() sets the default value and makes field not required', () => {
		const desc = t.boolean().default(false)._build()
		expect(desc.required).toBe(false)
		expect(desc.defaultValue).toBe(false)
	})

	test('.auto() marks the field as auto-populated', () => {
		const desc = t.timestamp().auto()._build()
		expect(desc.auto).toBe(true)
		expect(desc.required).toBe(false)
	})

	test('builders are immutable — modifiers return new instances', () => {
		const base = t.string()
		const optional = base.optional()
		const withDefault = base.default('hello')

		expect(base._build().required).toBe(true)
		expect(optional._build().required).toBe(false)
		expect(withDefault._build().defaultValue).toBe('hello')
		expect(base._build().defaultValue).toBeUndefined()
	})
})

describe('EnumFieldBuilder', () => {
	test('t.enum() creates an enum field with values', () => {
		const desc = t.enum(['low', 'medium', 'high'])._build()
		expect(desc.kind).toBe('enum')
		expect(desc.enumValues).toEqual(['low', 'medium', 'high'])
		expect(desc.required).toBe(true)
	})

	test('.default() sets default for enum', () => {
		const desc = t.enum(['low', 'medium', 'high']).default('medium')._build()
		expect(desc.defaultValue).toBe('medium')
		expect(desc.required).toBe(false)
	})

	test('.optional() works on enum', () => {
		const desc = t.enum(['a', 'b']).optional()._build()
		expect(desc.required).toBe(false)
		expect(desc.enumValues).toEqual(['a', 'b'])
	})

	test('returns EnumFieldBuilder from modifiers', () => {
		const optional = t.enum(['a', 'b']).optional()
		expect(optional).toBeInstanceOf(EnumFieldBuilder)
	})
})

describe('ArrayFieldBuilder', () => {
	test('t.array() creates an array field with item kind', () => {
		const desc = t.array(t.string())._build()
		expect(desc.kind).toBe('array')
		expect(desc.itemKind).toBe('string')
		expect(desc.required).toBe(true)
	})

	test('.default() sets default array value', () => {
		const desc = t.array(t.string()).default([])._build()
		expect(desc.defaultValue).toEqual([])
		expect(desc.required).toBe(false)
	})

	test('.optional() works on array', () => {
		const desc = t.array(t.number()).optional()._build()
		expect(desc.required).toBe(false)
		expect(desc.itemKind).toBe('number')
	})

	test('returns ArrayFieldBuilder from modifiers', () => {
		const optional = t.array(t.string()).optional()
		expect(optional).toBeInstanceOf(ArrayFieldBuilder)
	})

	test('supports different item types', () => {
		expect(t.array(t.number())._build().itemKind).toBe('number')
		expect(t.array(t.boolean())._build().itemKind).toBe('boolean')
		expect(t.array(t.timestamp())._build().itemKind).toBe('timestamp')
	})
})
