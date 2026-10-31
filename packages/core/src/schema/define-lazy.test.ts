import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerAccessCompiler } from '../access/access-compiler'
import { AccessNotLoadedError } from '../access/access-slot'
import { ACCESS_COMPILER_SLOT, type AccessCompilerSlot } from '../access/access-slot-key'
import { SchemaValidationError } from '../errors/errors'
import { defineSchema } from './define'
import { finalizeSchema } from './finalize-schema'
import { SCHEMA_FINALIZER_SLOT, type SchemaFinalizerSlot } from './schema-slot-key'
import { t } from './types'

const realm = globalThis as AccessCompilerSlot & SchemaFinalizerSlot

/** A production browser bundle: nothing registered the validators yet. */
describe('defineSchema without the finalizer (the first-paint descriptor)', () => {
	let savedAccess: AccessCompilerSlot[typeof ACCESS_COMPILER_SLOT]
	let savedFinalizer: SchemaFinalizerSlot[typeof SCHEMA_FINALIZER_SLOT]
	beforeEach(() => {
		savedAccess = realm[ACCESS_COMPILER_SLOT]
		savedFinalizer = realm[SCHEMA_FINALIZER_SLOT]
		realm[ACCESS_COMPILER_SLOT] = undefined
		realm[SCHEMA_FINALIZER_SLOT] = undefined
	})
	afterEach(() => {
		realm[ACCESS_COMPILER_SLOT] = savedAccess
		realm[SCHEMA_FINALIZER_SLOT] = savedFinalizer
	})

	const valid = () =>
		defineSchema({
			version: 1,
			collections: {
				todos: {
					fields: { title: t.string(), done: t.boolean().default(false) },
					indexes: ['done'],
					scope: ['title'],
				},
			},
			relations: {},
		})

	it('returns the collections and fields at once, before anything is validated', () => {
		const schema = valid()
		expect(Object.keys(schema.collections)).toEqual(['todos'])
		expect(Object.keys(schema.collections.todos?.fields ?? {})).toEqual(['title', 'done'])
		// Completed by the finalizer, not before.
		expect(schema.collections.todos?.scope).toEqual([])
	})

	it('reports a schema error when it is finalized, not when it is defined', () => {
		const schema = defineSchema({
			version: 1,
			collections: { 'bad name': { fields: { title: t.string() } } },
		})
		expect(() => finalizeSchema(schema)).toThrow(SchemaValidationError)
		// Still pending, so every later finalize reports it again.
		expect(() => finalizeSchema(schema)).toThrow(SchemaValidationError)
	})

	it('finalizing completes scope, indexes and relations in place and is idempotent', () => {
		const schema = valid()
		finalizeSchema(schema)
		finalizeSchema(schema)
		expect(schema.collections.todos?.scope).toEqual(['title'])
		expect(schema.collections.todos?.indexes).toEqual(['done'])
	})

	it('spreading or serializing it before the runtime loaded does not throw, with access rules declared', () => {
		const schema = defineSchema({
			version: 1,
			access: { memberships: 'members', roles: ['view', 'edit'] },
			collections: {
				members: {
					fields: { userId: t.string(), group: t.string(), role: t.enum(['view', 'edit']) },
				},
			},
		} as never)
		expect(() => JSON.stringify(schema)).not.toThrow()
		expect(() => ({ ...schema })).not.toThrow()
		expect(Object.keys(schema)).not.toContain('access')
		// An explicit read says the rules are not loaded yet.
		expect(() => schema.access).toThrow(AccessNotLoadedError)
	})

	it('registering the validators completes the schemas defined before, and access then reads and spreads', () => {
		const schema = defineSchema({
			version: 1,
			access: { memberships: 'members', roles: ['view', 'edit'] },
			collections: {
				members: {
					fields: { userId: t.string(), group: t.string(), role: t.enum(['view', 'edit']) },
				},
			},
		} as never)
		registerAccessCompiler()
		expect(schema.access).toBeDefined()
		expect(Object.keys({ ...schema })).toContain('access')
	})

	it('registering the validators does not throw for a schema that is invalid; its error waits for the explicit finalize', () => {
		const schema = defineSchema({
			version: 1,
			collections: { 'bad name': { fields: { title: t.string() } } },
		})
		expect(() => registerAccessCompiler()).not.toThrow()
		expect(() => finalizeSchema(schema)).toThrow(SchemaValidationError)
	})

	it('reading access of a schema whose rules are invalid, once the validators are registered, reports the rule error', () => {
		const schema = defineSchema({
			version: 1,
			access: { memberships: 'members' },
			collections: { members: { fields: { name: t.string() } } },
		} as never)
		registerAccessCompiler()
		// Not AccessNotLoadedError: the rules are loaded, they are wrong.
		expect(() => schema.access).toThrow(SchemaValidationError)
		expect(Object.keys(schema)).not.toContain('access')
	})

	it('serializing a schema whose sync rules or migrations are not added yet throws, after finalizing it works', () => {
		const schema = defineSchema({
			version: 1,
			collections: { todos: { fields: { title: t.string() } } },
			sync: { todos: { scope: [] } },
		} as never)
		expect(() => JSON.stringify(schema)).toThrow(SchemaValidationError)
		expect(() => ({ ...schema })).not.toThrow()
		finalizeSchema(schema)
		expect(() => JSON.stringify(schema)).not.toThrow()
		expect(JSON.parse(JSON.stringify(schema)).sync).toBeDefined()
	})
})
