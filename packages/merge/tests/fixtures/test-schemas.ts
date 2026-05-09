import type { CollectionDefinition, Constraint } from '@korajs/core'

/**
 * Simple schema with string, boolean, number, and array fields.
 * No constraints, no custom resolvers.
 */
export const simpleCollectionDef: CollectionDefinition = {
	fields: {
		title: {
			kind: 'string',
			required: true,
			defaultValue: '',
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		},
		completed: {
			kind: 'boolean',
			required: true,
			defaultValue: false,
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		},
		count: {
			kind: 'number',
			required: false,
			defaultValue: 0,
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		},
		tags: {
			kind: 'array',
			required: false,
			defaultValue: [],
			auto: false,
			enumValues: null,
			itemKind: 'string',
			mergeStrategy: null,
			transitions: null,
		},
		priority: {
			kind: 'enum',
			required: true,
			defaultValue: 'medium',
			auto: false,
			enumValues: ['low', 'medium', 'high'],
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		},
	},
	indexes: [],
	constraints: [],
	resolvers: {},
	scope: [],
}

/**
 * Schema with a unique constraint on the title field.
 */
export const constrainedCollectionDef: CollectionDefinition = {
	fields: {
		title: {
			kind: 'string',
			required: true,
			defaultValue: '',
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		},
		email: {
			kind: 'string',
			required: true,
			defaultValue: '',
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		},
		completed: {
			kind: 'boolean',
			required: true,
			defaultValue: false,
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		},
	},
	indexes: ['email'],
	constraints: [
		{
			type: 'unique',
			fields: ['email'],
			onConflict: 'last-write-wins',
		},
	],
	resolvers: {},
	scope: [],
}

/**
 * Schema with a custom resolver for the quantity field (additive merge).
 */
export const resolverCollectionDef: CollectionDefinition = {
	fields: {
		productId: {
			kind: 'string',
			required: true,
			defaultValue: '',
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		},
		quantity: {
			kind: 'number',
			required: true,
			defaultValue: 0,
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		},
		name: {
			kind: 'string',
			required: true,
			defaultValue: '',
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		},
	},
	indexes: [],
	constraints: [],
	resolvers: {
		quantity: (local: unknown, remote: unknown, base: unknown): unknown => {
			// Additive merge: apply both deltas to base
			const l = local as number
			const r = remote as number
			const b = base as number
			return Math.max(0, b + (l - b) + (r - b))
		},
	},
	scope: [],
}
