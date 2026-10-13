import { defineSchema, memberOfKey, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type {
	ProductionHttpRouteContext,
	RouteApplyResult,
	RouteMutation,
	RouteTransaction,
} from '../server/route-context'
import { RouteTransactionRejection } from '../server/route-context'
import type { MaterializedRecord, ServerStore } from '../store/server-store'
import { createAccessApi } from './access-api'

const schema = defineSchema({
	version: 1,
	access: { memberships: 'members', roles: ['view', 'edit'], groups: {} },
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group') },
		},
		courses: { fields: { title: t.string() } },
	},
})

/**
 * A route context over an in-memory members table without transactions (a custom store
 * without `transact`): decisions run with no isolation, like the route context does for
 * such a store. `afterQuery` runs after each query.
 */
function fakeContext(rows: MaterializedRecord[], afterQuery: (call: number) => void) {
	let calls = 0
	const query = async (
		_collection: string,
		options: { where?: Record<string, unknown>; limit?: number; offset?: number } = {},
	) => {
		const where = options.where ?? {}
		const matching = rows
			.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
			.sort((a, b) => String(a.id).localeCompare(String(b.id)))
		const offset = options.offset ?? 0
		const page = matching.slice(offset, offset + (options.limit ?? matching.length))
		calls += 1
		afterQuery(calls)
		return page
	}
	const apply = async (mutation: RouteMutation): Promise<RouteApplyResult> => {
		if (mutation.type === 'delete') {
			const index = rows.findIndex((row) => row.id === mutation.recordId)
			if (index >= 0) rows.splice(index, 1)
		}
		return { ok: true, operation: {} as never, record: null }
	}
	const tx: RouteTransaction = {
		findById: async () => null,
		query,
		roleOf: async () => null,
		reject: (code, message) => new RouteTransactionRejection(code, message),
	}
	return {
		query,
		apply,
		async transaction(
			decide: (tx: RouteTransaction) => Promise<RouteMutation[] | RouteTransactionRejection>,
		) {
			const decision = await decide(tx)
			if (decision instanceof RouteTransactionRejection) {
				return { ok: false, code: decision.code, message: decision.message, retriable: false }
			}
			const operations = []
			for (const mutation of decision) {
				const result = await apply(mutation)
				if (result.ok) operations.push(result.operation)
			}
			return { ok: true, operations, records: operations.map(() => null) }
		},
	} as unknown as ProductionHttpRouteContext
}

describe('server.access on a store without transactions', () => {
	test('revoke removes rows a concurrent delete shifted past a page boundary', async () => {
		const rows: MaterializedRecord[] = Array.from({ length: 101 }, (_, i) => ({
			id: `m-${String(i).padStart(3, '0')}`,
			userId: 'bob',
			group: 'courses:c1',
			role: 'view',
		}))
		// Another writer deletes a row of the first page right after it was read: the last
		// row moves to offset 99, before the next page's offset.
		const context = fakeContext(rows, (call) => {
			if (call === 1) rows.splice(0, 1)
		})
		const access = createAccessApi(context, {} as ServerStore, () => schema)
		await access.revoke({ userId: 'bob', group: ['courses', 'c1'] })
		expect(rows).toEqual([])
	})
})
