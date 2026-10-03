import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { SealedRelationFieldError, validateEncryptedRelations } from './encrypted-relations'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: { fields: { title: t.string(), projectId: t.string().optional() } },
		notes: { fields: { body: t.string(), projectId: t.string().optional() } },
		links: { fields: { projectId: t.string().optional() } },
		tags: { fields: { projectId: t.string().optional() } },
	},
	relations: {
		todoProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
		noteProject: {
			from: 'notes',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'set-null',
		},
		linkProject: {
			from: 'links',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'restrict',
		},
		tagProject: {
			from: 'tags',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'no-action',
		},
	},
}) as unknown as SchemaDefinition

const allCleartext = {
	todos: ['projectId'],
	notes: ['projectId'],
	links: ['projectId'],
}

describe('validateEncryptedRelations (RT-74, RT-78, RT-82)', () => {
	test('no encryption, or disabled: nothing to check', () => {
		expect(() => validateEncryptedRelations(schema, undefined)).not.toThrow()
		expect(() => validateEncryptedRelations(schema, { enabled: false })).not.toThrow()
	})

	test.each([
		['todoProject', 'todos', 'cascade'],
		['noteProject', 'notes', 'set-null'],
		['linkProject', 'links', 'restrict'],
	])(
		'a sealed foreign key of %s (%s, %s) is refused, naming the field and the fix',
		(relation, collection) => {
			const cleartextFields = Object.fromEntries(
				Object.entries(allCleartext).filter(([name]) => name !== collection),
			)
			let caught: unknown = null
			try {
				validateEncryptedRelations(schema, { enabled: true, cleartextFields })
			} catch (error) {
				caught = error
			}
			expect(caught).toBeInstanceOf(SealedRelationFieldError)
			const error = caught as SealedRelationFieldError
			expect(error.code).toBe('SEALED_RELATION_FIELD')
			expect(error.relation).toBe(relation)
			expect(error.collection).toBe(collection)
			expect(error.field).toBe('projectId')
			expect(error.message).toContain(`cleartextFields: { ${collection}: ['projectId'] }`)
		},
	)

	test('every enforced foreign key in cleartext passes; a no-action relation may stay sealed', () => {
		expect(() =>
			validateEncryptedRelations(schema, { enabled: true, cleartextFields: allCleartext }),
		).not.toThrow()
	})
})
