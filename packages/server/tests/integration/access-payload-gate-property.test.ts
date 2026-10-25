/**
 * Issue #78: no outbound operation of any type carries content the recipient's gate would
 * reject, in any field (`data`, `previousData`, ...). For random membership timelines of one
 * record that moves between groups, is edited and is then deleted, three devices of the same
 * user (one connected during the timeline, one resuming from the first device's watermark,
 * one fresh) are served while a stale write also arrives. Every body the record ever held is
 * a distinct token; a token may appear on the wire only if the user held a membership of the
 * group the record was in while that token was its live body (the oracle is built from the
 * log's membership rows, independent of the server's gate).
 *
 * The mutation check runs the same property with the gate switched off and requires a
 * counterexample, so the property is known to see the leak it guards against.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fc } from '@fast-check/vitest'
import { defineSchema, member, owner, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { scopeViewKey } from '@korajs/sync/internal'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { ClientSession } from '../../src/session/client-session'
import type { MemoryServerStore } from '../../src/store/memory-server-store'
import { SqliteServerStore } from '../../src/store/sqlite-server-store'
import { createHarness, makeOp, sendAndAwaitAck } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId'), delete: member('id', 'manage') },
		},
		comments: {
			fields: { documentId: t.string(), body: t.string() },
			access: {
				read: member('documentId', 'view', { group: 'documents' }),
				create: member('documentId', 'view', { group: 'documents' }),
				update: member('documentId', 'view', { group: 'documents' }),
				delete: member('documentId', 'view', { group: 'documents' }),
			},
		},
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'cat'].includes(token) ? { userId: token } : null),
})
const FRESH = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>
const GROUPS = ['d1', 'd2', 'd3'] as const

type Step =
	| { kind: 'grant'; group: (typeof GROUPS)[number] }
	| { kind: 'revoke'; group: (typeof GROUPS)[number] }
	| { kind: 'move'; group: (typeof GROUPS)[number] }
	| { kind: 'edit' }

const groupArb = fc.constantFrom(...GROUPS)
const stepArb: fc.Arbitrary<Step> = fc.oneof(
	fc.record({ kind: fc.constant('grant' as const), group: groupArb }),
	fc.record({ kind: fc.constant('revoke' as const), group: groupArb }),
	fc.record({ kind: fc.constant('move' as const), group: groupArb }),
	fc.record({ kind: fc.constant('edit' as const) }),
)

const memberStepArb: fc.Arbitrary<Step> = fc.oneof(
	fc.record({ kind: fc.constant('grant' as const), group: groupArb }),
	fc.record({ kind: fc.constant('revoke' as const), group: groupArb }),
)

const tmp = mkdtempSync(join(tmpdir(), 'kora-r13rev-prop-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

interface Interval {
	group: string
	from: number
	to: number
}

/** cat's membership intervals in the log, from the members rows alone (an independent oracle). */
function intervalsOf(log: Array<{ operation: Operation; deliverySequence: number }>): Interval[] {
	const open = new Map<string, Interval>()
	const all: Interval[] = []
	for (const { operation, deliverySequence } of log) {
		if (operation.collection !== 'members') continue
		if (operation.type === 'insert' && operation.data?.userId === 'cat') {
			const interval = {
				group: String(operation.data.group),
				from: deliverySequence,
				to: Number.POSITIVE_INFINITY,
			}
			open.set(operation.recordId, interval)
			all.push(interval)
		} else if (operation.type === 'delete') {
			const interval = open.get(operation.recordId)
			if (interval) {
				interval.to = deliverySequence
				open.delete(operation.recordId)
			}
		}
	}
	return all
}

describe("no outbound operation carries content the recipient's gate rejects", () => {
	let made = 0
	let withContent = 0
	const property = fc.asyncProperty(
		fc.array(stepArb, { minLength: 0, maxLength: 5 }),
		// After the delete only the membership moves: who may read what it removed.
		fc.array(memberStepArb, { minLength: 0, maxLength: 3 }),
		fc.nat(8),
		async (before, after, earlyAt) => {
			const steps: Step[] = [...before, ...after]
			const deleteAfter = before.length
			made += 1
			const db = new Database(join(tmp, `p-${made}.sqlite`))
			const store = new SqliteServerStore(drizzle(db), 's')
			const harness = await createHarness(schema, auth, {}, store as unknown as MemoryServerStore)
			try {
				const now = Date.now()
				const ann = await harness.login('ann', 'ann-node', FRESH)
				await sendAndAwaitAck(ann, [
					...GROUPS.map((group, index) =>
						makeOp('ann-node', index + 1, {
							collection: 'documents',
							recordId: group,
							data: { title: group, ownerId: 'ann' },
							timestamp: { wallTime: now + index, logical: 0, nodeId: 'ann-node' },
						}),
					),
					makeOp('ann-node', 4, {
						collection: 'comments',
						recordId: 'c1',
						data: { documentId: 'd1', body: 'init' },
						timestamp: { wallTime: now + 5, logical: 0, nodeId: 'ann-node' },
					}),
				])
				await harness.settle()
				await store.whenLiveViewsIdle?.()
				const context = harness.server.getKoraContext()
				const members = new Set<string>()
				let early: Awaited<ReturnType<typeof harness.login>> | null = null
				const connectEarly = async (): Promise<void> => {
					early = await harness.login('cat', 'cat-early', FRESH)
				}
				const deleteIndex = Math.min(deleteAfter, steps.length)
				const deleteRecord = async (): Promise<void> => {
					await context.apply({ collection: 'comments', type: 'delete', recordId: 'c1' })
					await harness.settle()
				}
				for (let i = 0; i < steps.length; i++) {
					if (i === deleteIndex) await deleteRecord()
					if (i === Math.min(earlyAt, steps.length)) await connectEarly()
					const step = steps[i]
					if (!step) continue
					const deleted = i >= deleteIndex
					if (step.kind === 'grant' && !members.has(step.group)) {
						members.add(step.group)
						await harness.server.access.grant({
							userId: 'cat',
							group: ['documents', step.group],
							role: 'view',
						})
					} else if (step.kind === 'revoke' && members.has(step.group)) {
						members.delete(step.group)
						await harness.server.access.revoke({
							userId: 'cat',
							group: ['documents', step.group],
						})
					} else if (step.kind === 'move' && !deleted) {
						await context.apply({
							collection: 'comments',
							type: 'update',
							recordId: 'c1',
							data: { documentId: step.group, body: `SECRET-${i}` },
						})
					} else if (step.kind === 'edit' && !deleted) {
						await context.apply({
							collection: 'comments',
							type: 'update',
							recordId: 'c1',
							data: { body: `SECRET-${i}` },
						})
					}
					await harness.settle()
				}
				if (deleteIndex >= steps.length) await deleteRecord()
				if (early === null) await connectEarly()
				const first = early as unknown as Awaited<ReturnType<typeof harness.login>>
				const watermark = Math.max(
					0,
					...first.messages.map((m) =>
						m.type === 'operation-batch' ? (m.maxDeliverySequence ?? 0) : 0,
					),
				)
				const accepted = first.messages.find((m) => m.type === 'handshake-response') as
					| { acceptedDownlinkScopes?: Record<string, Record<string, unknown>> }
					| undefined
				const rulesKey = first.messages
					.map((m) => (m as { accessRulesKey?: string }).accessRulesKey)
					.find((key) => key !== undefined)
				const resumer = await harness.login('cat', 'cat-resume', {
					supportsScopeDisjunction: true,
					lastDeliverySequence: watermark,
					acceptedScopeKey: scopeViewKey(accepted?.acceptedDownlinkScopes),
					acceptedScopeWatermark: watermark,
					accessRulesKey: rulesKey,
				} as Partial<SyncMessage>)
				// A stale write, older than every server write above.
				const tablet = await harness.login('ann', 'ann-tablet', FRESH)
				await sendAndAwaitAck(tablet, [
					makeOp('ann-tablet', 1, {
						type: 'update',
						collection: 'comments',
						recordId: 'c1',
						data: { body: 'STALE' },
						timestamp: { wallTime: now - 10_000, logical: 0, nodeId: 'ann-tablet' },
					}),
				])
				await harness.settle()
				await store.whenLiveViewsIdle?.()
				await harness.server.pollDeliveryLog()
				await harness.settle()
				const fresh = await harness.login('cat', 'cat-fresh', FRESH)
				await harness.settle()

				const log = await store.getOperationsAfterDelivery(0, 100_000)
				const intervals = intervalsOf(log)
				// Token lifetimes: SECRET-k is the live body of c1, in the group c1 was in, from its write
				// until the next body write or the delete.
				const life = new Map<string, { group: string; from: number; to: number }>()
				let group = 'd1'
				let current: string | null = null
				for (const { operation, deliverySequence } of log) {
					if (operation.collection !== 'comments' || operation.recordId !== 'c1') continue
					if (operation.nodeId === 'ann-tablet') continue
					if (operation.type === 'update' || operation.type === 'insert') {
						if (typeof operation.data?.documentId === 'string') group = operation.data.documentId
						if (typeof operation.data?.body === 'string') {
							if (current) life.get(current)!.to = deliverySequence
							current = operation.data.body
							life.set(current, {
								group: `documents:${group}`,
								from: deliverySequence,
								to: Number.POSITIVE_INFINITY,
							})
						}
					} else if (operation.type === 'delete') {
						if (current) life.get(current)!.to = Math.min(life.get(current)!.to, deliverySequence)
					}
				}
				for (const session of [first, resumer, fresh]) {
					for (const message of session.messages) {
						if (message.type !== 'operation-batch') continue
						for (const op of message.operations as Operation[]) {
							const wire = JSON.stringify(op)
							for (const [token, l] of life) {
								if (!token.startsWith('SECRET-') || !wire.includes(token)) continue
								withContent += 1
								const admitted = intervals.some(
									(i) => i.group === l.group && i.from < l.to && i.to > l.from,
								)
								expect(
									admitted,
									`op ${op.type}/${op.nodeId}/${op.id.slice(0, 8)} carried ${token} (group ${l.group}, life ${l.from}-${l.to}) with no overlapping membership; before ${JSON.stringify(before)} after ${JSON.stringify(after)} earlyAt ${earlyAt} deleteAfter ${deleteAfter}`,
								).toBe(true)
							}
						}
					}
				}
			} finally {
				await harness.server.stop()
				await store.close()
			}
		},
	)
	const reported: [Step[], Step[], number] = [
		[{ kind: 'grant', group: 'd1' }, { kind: 'move', group: 'd2' }, { kind: 'edit' }],
		[{ kind: 'grant', group: 'd2' }],
		1,
	]
	const params = {
		numRuns: 30,
		seed: 777,
		// The reported scenario: a member of the record's first group sees it move to a
		// group they join only after the delete, then meets a stale write.
		examples: [reported],
	}

	test('for random membership timelines (live, resumed and fresh devices)', async () => {
		await fc.assert(property, params)
		// Not vacuous: bodies were seen on the wire.
		expect(withContent).toBeGreaterThan(0)
	}, 600_000)

	test('mutation check: with the update branch of the gate switched off the same property finds a counterexample', async () => {
		type Gate = (ops: Operation[]) => Promise<Array<Operation | null>>
		const prototype = ClientSession.prototype as unknown as { cutUnprovablePayloads: Gate }
		const original = prototype.cutUnprovablePayloads
		// Deletes are still judged; updates leave as they were stored.
		const spy = vi.spyOn(prototype, 'cutUnprovablePayloads').mockImplementation(async function (
			this: unknown,
			ops,
		) {
			const judged = await original.call(this, ops)
			return judged.map((cut, index) =>
				ops[index]?.type === 'update' ? (ops[index] ?? null) : cut,
			)
		})
		try {
			const result = await fc.check(property, params)
			expect(result.failed).toBe(true)
		} finally {
			spy.mockRestore()
		}
	}, 600_000)
})
