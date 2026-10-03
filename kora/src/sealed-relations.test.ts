import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { sealedRelationNames } from './sealed-relations'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: { fields: { title: t.string(), projectId: t.string().optional() } },
		notes: { fields: { body: t.string(), projectId: t.string().optional() } },
		links: { fields: { projectId: t.string().optional() } },
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
	},
}) as unknown as SchemaDefinition

describe('sealedRelationNames (RT-74)', () => {
	test('no encryption, or disabled: nothing is sealed', () => {
		expect(sealedRelationNames(schema, undefined)).toEqual([])
		expect(sealedRelationNames(schema, { enabled: false })).toEqual([])
	})

	test('encryption: cascade and set-null relations whose field is not cleartext', () => {
		expect(sealedRelationNames(schema, { enabled: true })).toEqual(['noteProject', 'todoProject'])
		expect(
			sealedRelationNames(schema, { enabled: true, cleartextFields: { todos: ['projectId'] } }),
		).toEqual(['noteProject'])
	})
})
