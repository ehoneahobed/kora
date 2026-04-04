import type { CollectionDefinition, Constraint } from '@kora/core'
import { describe, expect, test } from 'vitest'
import type { ConstraintContext } from '../types'
import { checkConstraints } from './constraint-checker'

function makeCollectionDef(constraints: Constraint[]): CollectionDefinition {
	return {
		fields: {
			email: {
				kind: 'string',
				required: true,
				defaultValue: '',
				auto: false,
				enumValues: null,
				itemKind: null,
			},
			name: {
				kind: 'string',
				required: true,
				defaultValue: '',
				auto: false,
				enumValues: null,
				itemKind: null,
			},
			projectId: {
				kind: 'string',
				required: false,
				defaultValue: null,
				auto: false,
				enumValues: null,
				itemKind: null,
			},
		},
		indexes: [],
		constraints,
		resolvers: {},
	}
}

function makeContext(
	records: Record<string, Record<string, unknown>[]> = {},
	counts: Record<string, number> = {},
): ConstraintContext {
	return {
		async queryRecords(collection: string, where: Record<string, unknown>) {
			const collRecords = records[collection] ?? []
			return collRecords.filter((r) => {
				for (const [key, val] of Object.entries(where)) {
					if (r[key] !== val) return false
				}
				return true
			})
		},
		async countRecords(collection: string, where: Record<string, unknown>) {
			if (Object.keys(where).length === 0) {
				return counts[collection] ?? 0
			}
			const collRecords = records[collection] ?? []
			return collRecords.filter((r) => {
				for (const [key, val] of Object.entries(where)) {
					if (r[key] !== val) return false
				}
				return true
			}).length
		},
	}
}

describe('checkConstraints', () => {
	describe('unique constraints', () => {
		test('no violation when no duplicates exist', async () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef([constraint])
			const ctx = makeContext({ users: [] })

			const violations = await checkConstraints(
				{ id: 'rec-1', email: 'test@example.com', name: 'Test' },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(0)
		})

		test('violation when duplicate exists with different id', async () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef([constraint])
			const ctx = makeContext({
				users: [{ id: 'rec-2', email: 'test@example.com', name: 'Other' }],
			})

			const violations = await checkConstraints(
				{ id: 'rec-1', email: 'test@example.com', name: 'Test' },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(1)
			expect(violations[0]?.constraint.type).toBe('unique')
			expect(violations[0]?.fields).toEqual(['email'])
			expect(violations[0]?.message).toContain('Unique constraint violated')
		})

		test('no violation when same record has the value (self-match filtered)', async () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef([constraint])
			// The record itself is in the DB
			const ctx = makeContext({
				users: [{ id: 'rec-1', email: 'test@example.com', name: 'Test' }],
			})

			const violations = await checkConstraints(
				{ id: 'rec-1', email: 'test@example.com', name: 'Test' },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(0)
		})

		test('multi-field unique constraint', async () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['name', 'email'],
				onConflict: 'first-write-wins',
			}
			const collDef = makeCollectionDef([constraint])
			const ctx = makeContext({
				users: [{ id: 'rec-2', name: 'Test', email: 'test@example.com' }],
			})

			const violations = await checkConstraints(
				{ id: 'rec-1', name: 'Test', email: 'test@example.com' },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(1)
		})
	})

	describe('referential constraints', () => {
		test('no violation when referenced record exists', async () => {
			const constraint: Constraint = {
				type: 'referential',
				fields: ['projectId'],
				where: { collection: 'projects' },
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef([constraint])
			const ctx = makeContext({
				projects: [{ id: 'proj-1', name: 'Project A' }],
			})

			const violations = await checkConstraints(
				{ id: 'rec-1', projectId: 'proj-1', name: 'Test' },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(0)
		})

		test('violation when referenced record does not exist', async () => {
			const constraint: Constraint = {
				type: 'referential',
				fields: ['projectId'],
				where: { collection: 'projects' },
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef([constraint])
			const ctx = makeContext({ projects: [] })

			const violations = await checkConstraints(
				{ id: 'rec-1', projectId: 'proj-999', name: 'Test' },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(1)
			expect(violations[0]?.constraint.type).toBe('referential')
			expect(violations[0]?.message).toContain('referenced record not found')
		})

		test('null FK is allowed (optional relation)', async () => {
			const constraint: Constraint = {
				type: 'referential',
				fields: ['projectId'],
				where: { collection: 'projects' },
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef([constraint])
			const ctx = makeContext({ projects: [] })

			const violations = await checkConstraints(
				{ id: 'rec-1', projectId: null, name: 'Test' },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(0)
		})
	})

	describe('capacity constraints', () => {
		test('no violation when under capacity', async () => {
			const constraint: Constraint = {
				type: 'capacity',
				fields: ['projectId'],
				where: {},
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef([constraint])
			const ctx = makeContext({
				users: [{ id: 'rec-1', projectId: 'proj-1' }],
			})

			const violations = await checkConstraints(
				{ id: 'rec-1', projectId: 'proj-1', name: 'Test' },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(0)
		})

		test('violation when group count exceeds limit', async () => {
			const constraint: Constraint = {
				type: 'capacity',
				fields: ['projectId'],
				where: {},
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef([constraint])
			const ctx = makeContext(
				{
					users: [
						{ id: 'rec-1', projectId: 'proj-1' },
						{ id: 'rec-2', projectId: 'proj-1' },
					],
				},
				{ users: 2 },
			)

			const violations = await checkConstraints(
				{ id: 'rec-1', projectId: 'proj-1', name: 'Test' },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(1)
			expect(violations[0]?.constraint.type).toBe('capacity')
		})
	})

	describe('where clause filtering', () => {
		test('constraint is skipped when record does not match where clause', async () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				where: { active: true },
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef([constraint])
			const ctx = makeContext({
				users: [{ id: 'rec-2', email: 'test@example.com', active: true }],
			})

			// The merged record has active: false, so the constraint shouldn't apply
			const violations = await checkConstraints(
				{ id: 'rec-1', email: 'test@example.com', active: false },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(0)
		})
	})

	describe('multiple constraints', () => {
		test('checks all constraints and returns all violations', async () => {
			const constraints: Constraint[] = [
				{
					type: 'unique',
					fields: ['email'],
					onConflict: 'last-write-wins',
				},
				{
					type: 'referential',
					fields: ['projectId'],
					where: { collection: 'projects' },
					onConflict: 'last-write-wins',
				},
			]
			const collDef = makeCollectionDef(constraints)
			const ctx = makeContext({
				users: [{ id: 'rec-2', email: 'test@example.com' }],
				projects: [], // no projects
			})

			const violations = await checkConstraints(
				{ id: 'rec-1', email: 'test@example.com', projectId: 'proj-1' },
				'rec-1',
				'users',
				collDef,
				ctx,
			)

			expect(violations).toHaveLength(2)
		})
	})
})
