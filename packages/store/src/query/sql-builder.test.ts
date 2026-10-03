import type { FieldDescriptor } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { QueryError } from '../errors'
import type { OrderByDirection, QueryDescriptor } from '../types'
import {
	VIRTUAL_TIMESTAMP_FIELDS,
	buildCountQuery,
	buildInsertQuery,
	buildLwwSoftDeleteQuery,
	buildLwwUpdateQuery,
	buildSelectQuery,
	buildSoftDeleteQuery,
	buildUpdateQuery,
	buildWhereClause,
} from './sql-builder'

function field(
	kind: FieldDescriptor['kind'],
	overrides?: Partial<FieldDescriptor>,
): FieldDescriptor {
	return {
		kind,
		required: true,
		defaultValue: undefined,
		auto: false,
		enumValues: null,
		itemKind: null,
		mergeStrategy: null,
		transitions: null,
		...overrides,
	}
}

const todoFields: Record<string, FieldDescriptor> = {
	title: field('string'),
	completed: field('boolean'),
	priority: field('enum', { enumValues: ['low', 'medium', 'high'] }),
	count: field('number'),
	tags: field('array', { itemKind: 'string' }),
	due_date: field('timestamp', { required: false }),
}

describe('buildSelectQuery', () => {
	test('builds basic SELECT with soft-delete filter', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: {},
			orderBy: [],
		}
		const result = buildSelectQuery(descriptor, todoFields)
		expect(result.sql).toBe('SELECT * FROM "todos" WHERE _deleted = 0')
		expect(result.params).toEqual([])
	})

	test('adds WHERE conditions with soft-delete filter', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { completed: false },
			orderBy: [],
		}
		const result = buildSelectQuery(descriptor, todoFields)
		expect(result.sql).toBe('SELECT * FROM "todos" WHERE _deleted = 0 AND "completed" = ?')
		// Boolean false serialized to 0
		expect(result.params).toEqual([0])
	})

	test('adds ORDER BY clause', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: {},
			orderBy: [{ field: 'title', direction: 'asc' }],
		}
		const result = buildSelectQuery(descriptor, todoFields)
		expect(result.sql).toBe('SELECT * FROM "todos" WHERE _deleted = 0 ORDER BY "title" ASC')
	})

	test('adds multiple ORDER BY fields', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: {},
			orderBy: [
				{ field: 'priority', direction: 'desc' },
				{ field: 'title', direction: 'asc' },
			],
		}
		const result = buildSelectQuery(descriptor, todoFields)
		expect(result.sql).toContain('ORDER BY "priority" DESC, "title" ASC')
	})

	test('adds LIMIT and OFFSET', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: {},
			orderBy: [],
			limit: 10,
			offset: 20,
		}
		const result = buildSelectQuery(descriptor, todoFields)
		// SEC-7: bound as parameters, never spliced into the SQL text.
		expect(result.sql).toBe('SELECT * FROM "todos" WHERE _deleted = 0 LIMIT ? OFFSET ?')
		expect(result.params).toEqual([10, 20])
	})

	test('OFFSET without LIMIT is valid SQLite (LIMIT -1)', () => {
		const result = buildSelectQuery(
			{ collection: 'todos', where: {}, orderBy: [], offset: 5 },
			todoFields,
		)
		expect(result.sql).toBe('SELECT * FROM "todos" WHERE _deleted = 0 LIMIT -1 OFFSET ?')
		expect(result.params).toEqual([5])
	})

	test.each([
		['a non-integer', 1.5],
		['a negative number', -1],
		['NaN', Number.NaN],
		['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
		['a SQL string', '1; DROP TABLE todos'],
	])('rejects %s as limit or offset (SEC-7)', (_label, value) => {
		const bad = value as unknown as number
		expect(() =>
			buildSelectQuery({ collection: 'todos', where: {}, orderBy: [], limit: bad }, todoFields),
		).toThrow(QueryError)
		expect(() =>
			buildSelectQuery({ collection: 'todos', where: {}, orderBy: [], offset: bad }, todoFields),
		).toThrow(QueryError)
	})

	test('accepts uppercase directions and rejects anything else (SEC-7)', () => {
		const upper = buildSelectQuery(
			{
				collection: 'todos',
				where: {},
				orderBy: [{ field: 'title', direction: 'DESC' as OrderByDirection }],
			},
			todoFields,
		)
		expect(upper.sql).toContain('ORDER BY "title" DESC')
		for (const direction of ['ASC; DROP TABLE todos', 'up', '', 'asc ', 'constructor']) {
			expect(() =>
				buildSelectQuery(
					{
						collection: 'todos',
						where: {},
						orderBy: [{ field: 'title', direction: direction as OrderByDirection }],
					},
					todoFields,
				),
			).toThrow(QueryError)
		}
	})

	test('maps createdAt / updatedAt to their system columns (STORE-11)', () => {
		const result = buildSelectQuery(
			{
				collection: 'todos',
				where: { updatedAt: { $gt: 100 }, createdAt: 5 },
				orderBy: [{ field: 'createdAt', direction: 'desc' }],
			},
			todoFields,
		)
		expect(result.sql).toBe(
			'SELECT * FROM "todos" WHERE _deleted = 0 AND "_updated_at" > ? AND "_created_at" = ? ORDER BY "_created_at" DESC',
		)
		expect(result.params).toEqual([100, 5])
		expect(VIRTUAL_TIMESTAMP_FIELDS).toEqual({ createdAt: '_created_at', updatedAt: '_updated_at' })
	})

	test('a schema field named createdAt keeps its own column (STORE-11)', () => {
		const fields = { ...todoFields, createdAt: field('timestamp', { auto: true }) }
		const result = buildSelectQuery(
			{ collection: 'todos', where: {}, orderBy: [{ field: 'createdAt', direction: 'asc' }] },
			fields,
		)
		expect(result.sql).toContain('ORDER BY "createdAt" ASC')
	})

	test('handles multiple where conditions (AND)', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { completed: false, priority: 'high' },
			orderBy: [],
		}
		const result = buildSelectQuery(descriptor, todoFields)
		expect(result.sql).toContain('"completed" = ?')
		expect(result.sql).toContain('AND')
		expect(result.sql).toContain('"priority" = ?')
		expect(result.params).toContain(0) // false -> 0
		expect(result.params).toContain('high')
	})

	test('handles operator objects ($gt, $lt)', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { count: { $gt: 5, $lt: 10 } },
			orderBy: [],
		}
		const result = buildSelectQuery(descriptor, todoFields)
		expect(result.sql).toContain('"count" > ?')
		expect(result.sql).toContain('"count" < ?')
		expect(result.params).toEqual([5, 10])
	})

	test('handles $in operator', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { priority: { $in: ['low', 'high'] } },
			orderBy: [],
		}
		const result = buildSelectQuery(descriptor, todoFields)
		expect(result.sql).toContain('"priority" IN (?, ?)')
		expect(result.params).toEqual(['low', 'high'])
	})

	test('handles $eq with null (IS NULL)', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { due_date: null },
			orderBy: [],
		}
		const result = buildSelectQuery(descriptor, todoFields)
		expect(result.sql).toContain('"due_date" IS NULL')
		expect(result.params).toEqual([])
	})

	test('handles $ne with null (IS NOT NULL)', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { due_date: { $ne: null } },
			orderBy: [],
		}
		const result = buildSelectQuery(descriptor, todoFields)
		expect(result.sql).toContain('"due_date" IS NOT NULL')
	})

	test('allows querying by id field', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { id: 'abc-123' },
			orderBy: [],
		}
		const result = buildSelectQuery(descriptor, todoFields)
		expect(result.sql).toContain('"id" = ?')
		expect(result.params).toEqual(['abc-123'])
	})

	test('throws QueryError for unknown fields', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { nonexistent: 'value' },
			orderBy: [],
		}
		expect(() => buildSelectQuery(descriptor, todoFields)).toThrow(QueryError)
	})

	test('throws QueryError for unknown operators', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { title: { $regex: '.*' } },
			orderBy: [],
		}
		expect(() => buildSelectQuery(descriptor, todoFields)).toThrow(QueryError)
	})

	test('throws QueryError for $in with non-array value', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { title: { $in: 'not-an-array' as unknown } },
			orderBy: [],
		}
		expect(() => buildSelectQuery(descriptor, todoFields)).toThrow(QueryError)
	})

	test('throws QueryError for unknown ORDER BY field', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: {},
			orderBy: [{ field: 'nonexistent', direction: 'asc' }],
		}
		expect(() => buildSelectQuery(descriptor, todoFields)).toThrow(QueryError)
	})
})

describe('buildCountQuery', () => {
	test('builds COUNT query with soft-delete filter', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: {},
			orderBy: [],
		}
		const result = buildCountQuery(descriptor, todoFields)
		expect(result.sql).toBe('SELECT COUNT(*) as count FROM "todos" WHERE _deleted = 0')
		expect(result.params).toEqual([])
	})

	test('builds COUNT query with WHERE conditions', () => {
		const descriptor: QueryDescriptor = {
			collection: 'todos',
			where: { completed: true },
			orderBy: [],
		}
		const result = buildCountQuery(descriptor, todoFields)
		expect(result.sql).toBe(
			'SELECT COUNT(*) as count FROM "todos" WHERE _deleted = 0 AND "completed" = ?',
		)
		expect(result.params).toEqual([1]) // true -> 1
	})
})

describe('buildInsertQuery', () => {
	test('builds INSERT with all columns', () => {
		const record = {
			id: 'rec-1',
			title: 'Hello',
			completed: 0,
			_created_at: 1000,
			_updated_at: 1000,
		}
		const result = buildInsertQuery('todos', record)
		expect(result.sql).toBe(
			'INSERT INTO "todos" ("id", "title", "completed", "_created_at", "_updated_at") VALUES (?, ?, ?, ?, ?)',
		)
		expect(result.params).toEqual(['rec-1', 'Hello', 0, 1000, 1000])
	})
})

describe('buildUpdateQuery', () => {
	test('builds UPDATE with changed fields', () => {
		const result = buildUpdateQuery('todos', 'rec-1', {
			completed: 1,
			_updated_at: 2000,
		})
		expect(result.sql).toBe('UPDATE "todos" SET "completed" = ?, "_updated_at" = ? WHERE id = ?')
		expect(result.params).toEqual([1, 2000, 'rec-1'])
	})
})

describe('buildSoftDeleteQuery', () => {
	test('builds soft-delete UPDATE', () => {
		const result = buildSoftDeleteQuery('todos', 'rec-1', 3000)
		expect(result.sql).toBe('UPDATE "todos" SET _deleted = 1, _updated_at = ? WHERE id = ?')
		expect(result.params).toEqual([3000, 'rec-1'])
	})
})

describe('buildLwwUpdateQuery', () => {
	test('adds version guard to UPDATE', () => {
		const remoteVersion = '000000000001000:00000:remote'
		const result = buildLwwUpdateQuery(
			'todos',
			'rec-1',
			{ title: 'B', _updated_at: 1000, _version: remoteVersion },
			remoteVersion,
		)
		expect(result.sql).toContain('WHERE id = ? AND (_version = ? OR _version < ?)')
		expect(result.params[result.params.length - 2]).toBe('')
		expect(result.params[result.params.length - 1]).toBe(remoteVersion)
	})
})

describe('buildLwwSoftDeleteQuery', () => {
	test('adds version guard to soft delete', () => {
		const remoteVersion = '000000000002000:00000:remote'
		const result = buildLwwSoftDeleteQuery('todos', 'rec-1', 2000, remoteVersion)
		expect(result.sql).toContain('_version = ?')
		expect(result.sql).toContain('(_version = ? OR _version < ?)')
	})
})

describe('buildWhereClause', () => {
	test('returns null for empty conditions', () => {
		const result = buildWhereClause({}, todoFields)
		expect(result).toBeNull()
	})

	test('builds simple equality condition', () => {
		const result = buildWhereClause({ title: 'Hello' }, todoFields)
		expect(result).not.toBeNull()
		expect(result?.sql).toBe('"title" = ?')
		expect(result?.params).toEqual(['Hello'])
	})

	test('handles $gte and $lte operators', () => {
		const result = buildWhereClause({ count: { $gte: 1, $lte: 100 } }, todoFields)
		expect(result?.sql).toContain('"count" >= ?')
		expect(result?.sql).toContain('"count" <= ?')
		expect(result?.params).toEqual([1, 100])
	})
})
