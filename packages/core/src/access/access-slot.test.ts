import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SchemaValidationError } from '../errors/errors'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import { registerAccessCompiler } from './access-compiler'
import { AccessNotLoadedError } from './access-slot'
import { ACCESS_COMPILER_SLOT, type AccessCompilerSlot } from './access-slot-key'

const slot = globalThis as AccessCompilerSlot

/** Roles declared but no memberships collection: invalid as soon as it is compiled. */
function invalidAccessSchema(): ReturnType<typeof defineSchema> {
	return defineSchema({
		version: 1,
		access: { memberships: 'members' },
		collections: { members: { fields: { name: t.string() } } },
	} as never)
}

function validAccessSchema(): ReturnType<typeof defineSchema> {
	return defineSchema({
		version: 1,
		access: {
			memberships: 'members',
			roles: ['view', 'edit'],
		},
		collections: {
			members: {
				fields: {
					userId: t.string(),
					group: t.string(),
					role: t.enum(['view', 'edit']),
				},
			},
		},
	} as never)
}

describe('access rules in defineSchema', () => {
	let saved: AccessCompilerSlot[typeof ACCESS_COMPILER_SLOT]

	beforeEach(() => {
		saved = slot[ACCESS_COMPILER_SLOT]
	})
	afterEach(() => {
		slot[ACCESS_COMPILER_SLOT] = saved
	})

	describe('with the compiler loaded (development, a server, the runtime)', () => {
		it('validates when the schema is defined', () => {
			registerAccessCompiler()
			expect(() => invalidAccessSchema()).toThrow(SchemaValidationError)
		})

		it('exposes the compiled access straight away', () => {
			registerAccessCompiler()
			expect(validAccessSchema().access).toBeDefined()
		})
	})

	describe('without the compiler (a production browser build before the runtime loads)', () => {
		it('without the compiler defers validation to the first read of schema.access', () => {
			slot[ACCESS_COMPILER_SLOT] = undefined
			const schema = invalidAccessSchema()
			// defining did not throw; reading before anything loaded the compiler is an explicit error
			expect(() => schema.access).toThrow(AccessNotLoadedError)
			registerAccessCompiler()
			// the runtime's read then raises the same error the development build raised at definition
			expect(() => schema.access).toThrow(SchemaValidationError)
		})

		it('compiles once, on the first read after the compiler loaded', () => {
			slot[ACCESS_COMPILER_SLOT] = undefined
			const schema = validAccessSchema()
			registerAccessCompiler()
			const first = schema.access
			expect(first).toBeDefined()
			expect(schema.access).toBe(first)
		})

		it('leaves schemas without access rules untouched', () => {
			slot[ACCESS_COMPILER_SLOT] = undefined
			const schema = defineSchema({
				version: 1,
				collections: { todos: { fields: { title: t.string() } } },
			})
			expect(schema.access).toBeUndefined()
			expect('access' in schema).toBe(false)
		})
	})
})
