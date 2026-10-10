/**
 * `createProductionServer` exposes the access API to background code (`server.access`)
 * and to custom routes (`request.access`): an "accept invitation" route grants the
 * membership through it.
 */
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'manage'],
		groups: { boards: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group', 'manage') },
		},
		boards: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId') },
		},
	},
})

describe('access API on the production server', () => {
	test('a custom route grants a membership with request.access', async () => {
		const store = new MemoryServerStore('s')
		await store.setSchema(schema, { accessRulesEnforced: true })
		const server = createProductionServer({
			store,
			port: 0,
			staticDir: '/nonexistent',
			syncOptions: { experimentalAccessRules: true, accessSweepIntervalMs: 0 },
			httpRoutes: [
				{
					path: '/api/accept',
					async handle(request) {
						const { userId, boardId } = request.body as { userId: string; boardId: string }
						const result = await request.access.grant({
							userId,
							group: ['boards', boardId],
							role: 'view',
						})
						return { status: result.ok ? 200 : 400, body: result }
					},
				},
			],
		})
		const base = await server.start()
		try {
			await server.kora.apply({
				collection: 'boards',
				type: 'insert',
				recordId: 'b1',
				data: { title: 'Plan', ownerId: 'ann' },
			})
			const response = await fetch(`${base}/api/accept`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ userId: 'bob', boardId: 'b1' }),
			})
			expect(response.status).toBe(200)
			const intervals = (await store.getMembershipIntervals?.('bob')) ?? []
			expect(intervals.map((i) => [i.group, i.role])).toEqual([['boards:b1', 'view']])
			// The same API for background jobs.
			await server.access.revoke({ userId: 'bob', group: ['boards', 'b1'] })
			expect((await store.getMembershipIntervals?.('bob'))?.[0]?.leftSeq).not.toBeNull()
		} finally {
			await server.stop()
		}
	})
})
