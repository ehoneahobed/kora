import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	HybridLogicalClock,
	createOperation,
	defineSchema,
	generateUUIDv7,
	memberOfKey,
	owner,
	t,
} from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fullSchema, minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { StampedFieldError, StoreNotOpenError } from '../errors'
import type { Transaction } from '../types'
import { Store } from './store'

describe('Store', () => {
	let store: Store
	let adapter: BetterSqlite3Adapter

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: minimalSchema, adapter, nodeId: 'test-node' })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	describe('open/close', () => {
		test('initializes with provided nodeId', () => {
			expect(store.getNodeId()).toBe('test-node')
		})

		test('generates nodeId if not provided', async () => {
			const s = new Store({ schema: minimalSchema, adapter: new BetterSqlite3Adapter(':memory:') })
			await s.open()
			expect(store.getNodeId()).toBeTruthy()
			expect(typeof s.getNodeId()).toBe('string')
			await s.close()
		})

		test('uses configured nodeId when provided', async () => {
			const s = new Store({
				schema: minimalSchema,
				adapter: new BetterSqlite3Adapter(':memory:'),
				nodeId: 'custom-node-id',
			})
			await s.open()
			expect(s.getNodeId()).toBe('custom-node-id')
			await s.close()
		})

		test('starts with empty version vector', () => {
			expect(store.getVersionVector().size).toBe(0)
		})

		test('throws StoreNotOpenError before open', async () => {
			const s = new Store({ schema: minimalSchema, adapter: new BetterSqlite3Adapter(':memory:') })
			expect(() => s.collection('todos')).toThrow(StoreNotOpenError)
			expect(() => s.getNodeId()).toThrow(StoreNotOpenError)
			expect(() => s.getVersionVector()).toThrow(StoreNotOpenError)
		})
	})

	describe('collection', () => {
		test('returns a collection accessor for a valid collection', () => {
			const col = store.collection('todos')
			expect(col).toBeDefined()
			expect(typeof col.insert).toBe('function')
			expect(typeof col.findById).toBe('function')
			expect(typeof col.update).toBe('function')
			expect(typeof col.delete).toBe('function')
			expect(typeof col.where).toBe('function')
		})

		test('throws for unknown collection', () => {
			expect(() => store.collection('nonexistent')).toThrow('Unknown collection')
		})
	})

	describe('CRUD through Store', () => {
		test('insert and findById', async () => {
			const col = store.collection('todos')
			const record = await col.insert({ title: 'Store test' })

			expect(record.id).toBeDefined()
			expect(record.title).toBe('Store test')

			const found = await col.findById(record.id)
			expect(found?.title).toBe('Store test')
		})

		test('update', async () => {
			const col = store.collection('todos')
			const record = await col.insert({ title: 'Before' })
			const updated = await col.update(record.id, { title: 'After' })

			expect(updated.title).toBe('After')
		})

		test('delete', async () => {
			const col = store.collection('todos')
			const record = await col.insert({ title: 'To delete' })
			await col.delete(record.id)

			const found = await col.findById(record.id)
			expect(found).toBeNull()
		})

		test('scope retraction hides a row without authoring a delete operation', async () => {
			const col = store.collection('todos')
			const record = await col.insert({ title: 'Authorized copy' })
			const before = await store.getOperationRange('test-node', 1, 100)

			await store.applyScopeRetraction('todos', record.id)

			expect(await col.findById(record.id)).toBeNull()
			expect(await store.getOperationRange('test-node', 1, 100)).toEqual(before)
		})

		test('scope narrowing uses the shared matcher: a $or grant keeps rows of any branch', async () => {
			const col = store.collection('todos')
			const a = await col.insert({ title: 'a' })
			const b = await col.insert({ title: 'b', completed: true })
			const c = await col.insert({ title: 'c' })

			const retracted = await store.applyScopeNarrowing({
				todos: { $or: [{ title: 'a' }, { completed: true }] },
			})

			expect(retracted).toEqual([{ collection: 'todos', recordId: c.id }])
			expect(await col.findById(a.id)).not.toBeNull()
			expect(await col.findById(b.id)).not.toBeNull()
			expect(await col.findById(c.id)).toBeNull()
		})

		test('scope narrowing stops between rows once its session ends', async () => {
			const col = store.collection('todos')
			const a = await col.insert({ title: 'a' })
			const b = await col.insert({ title: 'b' })
			const retraction = vi.spyOn(store, 'applyScopeRetraction')

			const retracted = await store.applyScopeNarrowing(
				{ todos: { title: 'none' } },
				// The session ends once the first row is hidden.
				{ shouldContinue: () => retraction.mock.calls.length === 0 },
			)

			expect(retracted).toHaveLength(1)
			const remaining = [await col.findById(a.id), await col.findById(b.id)].filter(Boolean)
			expect(remaining).toHaveLength(1)
		})

		describe('stamped fields', () => {
			const stamped = defineSchema({
				version: 1,
				access: { memberships: 'members', roles: ['view'], groups: {} },
				collections: {
					members: {
						fields: { userId: t.string(), group: t.string(), role: t.string() },
						access: { read: memberOfKey('group') },
					},
					plain: { fields: { body: t.string() } },
					notes: {
						fields: { body: t.string(), authorId: t.string().stamp('userId') },
						access: { read: owner('authorId'), create: owner('authorId') },
					},
				},
			})

			async function open(user: string | null): Promise<Store> {
				const s = new Store({
					schema: stamped,
					adapter: new BetterSqlite3Adapter(':memory:'),
					nodeId: 'n',
				})
				await s.open()
				if (user) await s.bindPrincipal(user)
				return s
			}

			test('an insert fills the stamped field with the signed-in user', async () => {
				const s = await open('ann')
				const note = await s.collection('notes').insert({ body: 'hi' })
				expect(note.authorId).toBe('ann')
				const [op] = await s.getOperationRange('n', 1, 1)
				expect(op?.data).toMatchObject({ authorId: 'ann' })
				await s.close()
			})

			test('a retraction of a record with unsent writes waits for them, then hides it', async () => {
				const s = await open('ann')
				const note = await s.collection('notes').insert({ body: 'hi' })
				expect(await s.deferScopeRetraction('notes', note.id)).toBe(true)
				expect(await s.collection('notes').findById(note.id)).not.toBeNull()
				// Still pending.
				expect(
					await s.recheckAccessNarrowing(() => new Set([note.id]), { retractedOnly: true }),
				).toEqual([])
				// Resolved (even accepted): hidden.
				expect(await s.recheckAccessNarrowing(() => new Set(), { retractedOnly: true })).toEqual([
					{ collection: 'notes', recordId: note.id },
				])
				expect(await s.collection('notes').findById(note.id)).toBeNull()
				await s.close()
			})

			test('a stale deferral persists nothing', async () => {
				const s = await open('ann')
				const note = await s.collection('notes').insert({ body: 'hi' })
				// The delivery that asked is no longer current: the deferral must not be recorded,
				// or a later recheck would hide the record on behalf of a batch that never applied.
				expect(await s.deferScopeRetraction('notes', note.id, { isCurrent: () => false })).toBe(
					true,
				)
				expect(await s.recheckAccessNarrowing(() => new Set(), { retractedOnly: true })).toEqual([])
				expect(await s.collection('notes').findById(note.id)).not.toBeNull()
				await s.close()
			})

			test('a deferral for a delivery that moved writes nothing at all, at every point it could move', async () => {
				const s = await open('ann')
				const note = await s.collection('notes').insert({ body: 'hi' })
				const adapter = (
					s as unknown as {
						adapter: { transaction: (fn: (tx: Transaction) => Promise<void>) => Promise<void> }
					}
				).adapter
				const realTransaction = adapter.transaction.bind(adapter)
				let writes = 0
				adapter.transaction = (fn) =>
					realTransaction((tx) =>
						fn({
							query: (sql, params) => tx.query(sql, params),
							execute: (sql, params) => {
								writes++
								return tx.execute(sql, params)
							},
						}),
					)
				// Moved before the transaction starts writing: not one statement may run.
				expect(await s.deferScopeRetraction('notes', note.id, { isCurrent: () => false })).toBe(
					true,
				)
				expect(writes).toBe(0)
				// Moved after the statements ran, before the commit: the rollback leaves nothing recorded.
				let checks = 0
				await s.deferScopeRetraction('notes', note.id, { isCurrent: () => ++checks <= 1 })
				expect(checks).toBe(2)
				expect(writes).toBeGreaterThan(0)
				expect(await s.recheckAccessNarrowing(() => new Set(), { retractedOnly: true })).toEqual([])
				expect(await s.collection('notes').findById(note.id)).not.toBeNull()
				await s.close()
			})

			test('a deferral queued behind another transaction records nothing once the position moved (review 7, R7-2)', async () => {
				const s = await open('ann')
				const note = await s.collection('notes').insert({ body: 'hi' })
				await s.recheckAccessNarrowing(() => new Set())
				const adapter = (
					s as unknown as {
						adapter: { transaction: (fn: (tx: Transaction) => Promise<void>) => Promise<void> }
					}
				).adapter
				// Hold the adapter's transaction slot; the deferral queues behind it.
				let release: () => void = () => {}
				const gate = new Promise<void>((resolve) => {
					release = resolve
				})
				let entered: () => void = () => {}
				const inside = new Promise<void>((resolve) => {
					entered = resolve
				})
				const held = adapter.transaction(async () => {
					entered()
					await gate
				})
				await inside
				let current = true
				const deferral = s.deferScopeRetraction('notes', note.id, { isCurrent: () => current })
				// The delivery moves while the deferral waits for the slot.
				current = false
				release()
				await held
				await deferral
				expect(await s.recheckAccessNarrowing(() => new Set(), { retractedOnly: true })).toEqual([])
				expect(await s.collection('notes').findById(note.id)).not.toBeNull()
				await s.close()
			})

			test('a list a narrowing kept is judged only under the view it narrowed for', async () => {
				const s = await open('ann')
				const col = s.collection('notes')
				const kept = await col.insert({ body: 'mine' })
				// Narrowed for view A (the record is outside A's scope and has an unsent write).
				await s.applyCollectionNarrowing(
					'notes',
					{ body: 'other' },
					new Set([kept.id]),
					undefined,
					{
						view: 'A',
					},
				)
				// Under view B the scope says nothing about it: it stays, and is still remembered.
				expect(await s.recheckAccessNarrowing(() => new Set(), { view: 'B' })).toEqual([])
				expect(await col.findById(kept.id)).not.toBeNull()
				// Back under A the writes are resolved and it is outside A's scope: hidden.
				expect(await s.recheckAccessNarrowing(() => new Set(), { view: 'A' })).toEqual([
					{ collection: 'notes', recordId: kept.id },
				])
				expect(await col.findById(kept.id)).toBeNull()
				await s.close()
			})

			test('a list kept without a view is judged under any view (stored before views were tagged)', async () => {
				const s = await open('ann')
				const col = s.collection('notes')
				const kept = await col.insert({ body: 'mine' })
				await s.applyCollectionNarrowing('notes', { body: 'other' }, new Set([kept.id]))
				expect(await s.recheckAccessNarrowing(() => new Set(), { view: 'B' })).toEqual([
					{ collection: 'notes', recordId: kept.id },
				])
				await s.close()
			})

			test('a collection without access rules is retracted at once', async () => {
				const s = await open('ann')
				expect(await s.deferScopeRetraction('plain', 'p1')).toBe(false)
				await s.close()
			})

			test('while another user is being bound, nothing is stamped', async () => {
				// Not pinned: a new user moves to a node of their own.
				const s = new Store({ schema: stamped, adapter: new BetterSqlite3Adapter(':memory:') })
				await s.open()
				await s.bindPrincipal('ann')
				const binding = s.bindPrincipal('bob')
				await expect(s.collection('notes').insert({ body: 'hi' })).rejects.toMatchObject({
					code: 'STAMP_USER_UNKNOWN',
				})
				await binding
				expect((await s.collection('notes').insert({ body: 'hi' })).authorId).toBe('bob')
				await s.close()
			})

			test('a transaction stamps the user whose node it was opened under', async () => {
				const s = new Store({ schema: stamped, adapter: new BetterSqlite3Adapter(':memory:') })
				await s.open()
				await s.bindPrincipal('ann')
				const tx = s.createTransaction()
				await s.bindPrincipal('bob')
				const note = await tx.collection('notes').insert({ body: 'hi' })
				expect(note.authorId).toBe('ann')
				await s.close()
			})

			test('a deferred retraction whose save failed is saved when retried', async () => {
				const dir = mkdtempSync(join(tmpdir(), 'kora-defer-'))
				const path = join(dir, 'db.sqlite')
				try {
					const adapter = new BetterSqlite3Adapter(path)
					const first = new Store({ schema: stamped, adapter, nodeId: 'n' })
					await first.open()
					await first.bindPrincipal('ann')
					const note = await first.collection('notes').insert({ body: 'hi' })
					const transaction = adapter.transaction.bind(adapter)
					let fail = true
					// The deferral is written inside a transaction: its first meta write fails once.
					adapter.transaction = ((fn: (tx: Transaction) => Promise<void>) =>
						transaction((tx: Transaction) =>
							fn({
								execute: async (sql: string, params?: unknown[]) => {
									if (fail && sql.includes('_kora_meta')) {
										fail = false
										throw new Error('disk full')
									}
									return tx.execute(sql, params)
								},
								query: (sql: string, params?: unknown[]) => tx.query(sql, params),
							}),
						)) as typeof adapter.transaction
					await expect(first.deferScopeRetraction('notes', note.id)).rejects.toThrow('disk full')
					expect(await first.deferScopeRetraction('notes', note.id)).toBe(true)
					await first.close()

					const second = new Store({
						schema: stamped,
						adapter: new BetterSqlite3Adapter(path),
						nodeId: 'n',
					})
					await second.open()
					expect(
						await second.recheckAccessNarrowing(() => new Set(), { retractedOnly: true }),
					).toEqual([{ collection: 'notes', recordId: note.id }])
					await second.close()
				} finally {
					rmSync(dir, { recursive: true, force: true })
				}
			})

			test('after sign-out nothing is stamped with the previous user', async () => {
				const s = await open('ann')
				s.clearSignedInUser()
				await expect(s.collection('notes').insert({ body: 'hi' })).rejects.toMatchObject({
					code: 'STAMP_USER_UNKNOWN',
				})
				await s.close()
			})

			test('naming another user is refused', async () => {
				const s = await open('ann')
				await expect(
					s.collection('notes').insert({ body: 'hi', authorId: 'bob' }),
				).rejects.toMatchObject({
					code: 'STAMP_MISMATCH',
				})
				await s.close()
			})

			test('without a known user the field must be given', async () => {
				const s = await open(null)
				await expect(s.collection('notes').insert({ body: 'hi' })).rejects.toBeInstanceOf(
					StampedFieldError,
				)
				expect((await s.collection('notes').insert({ body: 'hi', authorId: 'ann' })).authorId).toBe(
					'ann',
				)
				await s.close()
			})
		})

		describe('access narrowing', () => {
			test('hides rows outside the scope, keeps pending ones, and hides those once refused', async () => {
				const col = store.collection('todos')
				const a = await col.insert({ title: 'a' })
				const b = await col.insert({ title: 'b' })
				const c = await col.insert({ title: 'c' })
				const hidden = await store.applyCollectionNarrowing(
					'todos',
					{ title: 'a' },
					new Set([b.id]),
				)
				expect(hidden).toEqual([c.id])
				expect(await col.findById(a.id)).not.toBeNull()
				expect(await col.findById(b.id)).not.toBeNull()

				// Still pending: kept.
				expect(await store.recheckAccessNarrowing(() => new Set([b.id]))).toEqual([])
				expect(await col.findById(b.id)).not.toBeNull()
				// Its writes refused: hidden.
				expect(await store.recheckAccessNarrowing(() => new Set())).toEqual([
					{ collection: 'todos', recordId: b.id },
				])
				expect(await col.findById(b.id)).toBeNull()
			})

			test('a narrowing for a position that moved hides nothing, at every point it could move', async () => {
				const col = store.collection('todos')
				const a = await col.insert({ title: 'a' })
				const b = await col.insert({ title: 'b' })
				const k = await col.insert({ title: 'k' })
				// Moved before the transaction wrote anything: nothing is hidden, nothing recorded.
				expect(
					await store.applyCollectionNarrowing('todos', null, new Set([k.id]), undefined, {
						isCurrent: () => false,
					}),
				).toEqual([])
				expect(await col.findById(a.id)).not.toBeNull()
				expect(await store.recheckAccessNarrowing(() => new Set())).toEqual([])
				// Moved after the hides, before the commit: all of it rolls back (no half narrowing).
				let calls = 0
				const hidden = await store.applyCollectionNarrowing(
					'todos',
					null,
					new Set([k.id]),
					undefined,
					{ isCurrent: () => ++calls <= 2 },
				)
				expect(hidden).toEqual([])
				expect(calls).toBe(3)
				for (const id of [a.id, b.id, k.id]) expect(await col.findById(id)).not.toBeNull()
				expect(await store.recheckAccessNarrowing(() => new Set())).toEqual([])
				// Still current: hidden, and the kept one remembered.
				const done = await store.applyCollectionNarrowing(
					'todos',
					null,
					new Set([k.id]),
					undefined,
					{
						isCurrent: () => true,
					},
				)
				expect(done.sort()).toEqual([a.id, b.id].sort())
			})

			test('a hide for a delivery that moved while the transaction waited hides nothing', async () => {
				const col = store.collection('todos')
				const a = await col.insert({ title: 'a' })
				let current = true
				// The flip lands after the caller's own check, inside the wait for the adapter.
				const promise = store.applyScopeRetraction('todos', a.id, undefined, {
					isCurrent: () => current,
				})
				current = false
				expect(await promise).toBe(false)
				expect(await col.findById(a.id)).not.toBeNull()
				expect(
					await store.applyScopeRetraction('todos', a.id, undefined, { isCurrent: () => true }),
				).toBe(true)
				expect(await col.findById(a.id)).toBeNull()
			})

			test('a hide whose delivery moves after its writes ran rolls back and hides nothing', async () => {
				const col = store.collection('todos')
				const a = await col.insert({ title: 'a' })
				let asked = 0
				// Current at the transaction's start, stale when it would commit.
				const hidden = await store.applyScopeRetraction('todos', a.id, 4, {
					isCurrent: () => ++asked < 2,
				})
				expect(hidden).toBe(false)
				expect(asked).toBe(2)
				expect(await col.findById(a.id)).not.toBeNull()
				const markers = await (
					store as unknown as { adapter: { query(sql: string): Promise<unknown[]> } }
				).adapter.query('SELECT * FROM _kora_scope_retractions')
				expect(markers).toEqual([])
			})

			test('a narrowing queued behind another transaction hides nothing once the position moved (review 7, R7-1)', async () => {
				const col = store.collection('todos')
				const a = await col.insert({ title: 'a' })
				let current = true
				const adapter = (
					store as unknown as {
						adapter: { transaction: (fn: (tx: Transaction) => Promise<void>) => Promise<void> }
					}
				).adapter
				const realTransaction = adapter.transaction.bind(adapter)
				// The position moves at the moment the hide enters the transaction: the caller's own
				// check has already passed.
				adapter.transaction = (fn) => {
					current = false
					return realTransaction(fn)
				}
				const hidden = await store.applyCollectionNarrowing('todos', null, new Set(), 1.25, {
					isCurrent: () => current,
				})
				expect(hidden).toEqual([])
				expect(await col.findById(a.id)).not.toBeNull()
			})

			test('a narrowing that goes stale after hiding some rows rolls all of them back (review 7, R7-3)', async () => {
				const col = store.collection('todos')
				const ids: string[] = []
				for (const title of ['a', 'b', 'c', 'd']) ids.push((await col.insert({ title })).id)
				// Current for the first `allowed` checks, stale after: wherever it flips, the narrowing
				// is all or nothing (rows hidden before it went stale are not left hidden).
				let rolledBack = 0
				for (const allowed of [0, 1, 2, 3]) {
					let calls = 0
					const hidden = await store.applyCollectionNarrowing('todos', null, new Set(), 1.25, {
						isCurrent: () => ++calls <= allowed,
					})
					const visible = (await Promise.all(ids.map((id) => col.findById(id)))).filter(
						(row) => row !== null,
					)
					if (hidden.length === 0) {
						rolledBack++
						expect(visible).toHaveLength(4)
					} else {
						expect(hidden).toHaveLength(4)
						expect(visible).toHaveLength(0)
						break
					}
				}
				// It flipped at least once after the first check passed (the pre-commit check).
				expect(rolledBack).toBeGreaterThanOrEqual(2)
			})

			test('a narrowing that moves before it records what it kept remembers nothing', async () => {
				const col = store.collection('todos')
				const k = await col.insert({ title: 'k' })
				let checks = 0
				// The first check (after the read) passes; the one before the save does not.
				await store.applyCollectionNarrowing(
					'todos',
					{ title: 'other' },
					new Set([k.id]),
					undefined,
					{
						isCurrent: () => ++checks <= 1,
					},
				)
				expect(checks).toBe(2)
				expect(await store.recheckAccessNarrowing(() => new Set())).toEqual([])
				expect(await col.findById(k.id)).not.toBeNull()
			})

			test('a null scope hides the whole collection', async () => {
				const col = store.collection('todos')
				const a = await col.insert({ title: 'a' })
				expect(await store.applyCollectionNarrowing('todos', null, new Set())).toEqual([a.id])
			})

			test('a kept record the server sends again is no longer rechecked', async () => {
				const col = store.collection('todos')
				const b = await col.insert({ title: 'b' })
				await store.applyCollectionNarrowing('todos', { title: 'a' }, new Set([b.id]))
				const entry: Operation = {
					id: 'scope-entry-kept',
					nodeId: 'kora:scope-entry',
					type: 'insert',
					collection: 'todos',
					recordId: b.id,
					data: { title: 'b' },
					previousData: null,
					timestamp: { wallTime: 1, logical: 0, nodeId: 'remote' },
					sequenceNumber: 0,
					causalDeps: [],
					schemaVersion: 1,
				}
				await store.applyRemoteOperation(entry)
				expect(await store.recheckAccessNarrowing(() => new Set())).toEqual([])
				expect(await col.findById(b.id)).not.toBeNull()
			})

			test('the view a list was kept for survives a reopen', async () => {
				const dir = mkdtempSync(join(tmpdir(), 'kora-narrowing-view-'))
				const path = join(dir, 'db.sqlite')
				try {
					const open = async (): Promise<Store> => {
						const s = new Store({
							schema: minimalSchema,
							adapter: new BetterSqlite3Adapter(path),
							nodeId: 'n',
						})
						await s.open()
						return s
					}
					const first = await open()
					const b = await first.collection('todos').insert({ title: 'b' })
					await first.applyCollectionNarrowing('todos', null, new Set([b.id]), undefined, {
						view: 'A',
					})
					await first.close()
					const second = await open()
					expect(await second.recheckAccessNarrowing(() => new Set(), { view: 'B' })).toEqual([])
					expect(await second.recheckAccessNarrowing(() => new Set(), { view: 'A' })).toEqual([
						{ collection: 'todos', recordId: b.id },
					])
					await second.close()
				} finally {
					rmSync(dir, { recursive: true, force: true })
				}
			})

			test('the kept records survive a reopen', async () => {
				const dir = mkdtempSync(join(tmpdir(), 'kora-narrowing-'))
				const path = join(dir, 'db.sqlite')
				try {
					const first = new Store({
						schema: minimalSchema,
						adapter: new BetterSqlite3Adapter(path),
						nodeId: 'n',
					})
					await first.open()
					const b = await first.collection('todos').insert({ title: 'b' })
					await first.applyCollectionNarrowing('todos', null, new Set([b.id]))
					await first.close()

					const second = new Store({
						schema: minimalSchema,
						adapter: new BetterSqlite3Adapter(path),
						nodeId: 'n',
					})
					await second.open()
					expect(await second.recheckAccessNarrowing(() => new Set())).toEqual([
						{ collection: 'todos', recordId: b.id },
					])
					await second.close()
				} finally {
					rmSync(dir, { recursive: true, force: true })
				}
			})
		})

		test('scope narrowing fails closed: a malformed $or hides every row', async () => {
			const col = store.collection('todos')
			const a = await col.insert({ title: 'a' })
			await store.applyScopeNarrowing({ todos: { $or: [] } })
			expect(await col.findById(a.id)).toBeNull()
		})

		test('rotateNodeId re-authors unsynced operations under a fresh node id (RT-21)', async () => {
			const unpinned = new Store({
				schema: minimalSchema,
				adapter: new BetterSqlite3Adapter(':memory:'),
			})
			await unpinned.open()
			const col = unpinned.collection('todos')
			const a = await col.insert({ title: 'a' })
			await col.update(a.id, { title: 'a2' })
			const before = unpinned.getNodeId()
			const ops = await unpinned.getOperationRange(before, 1, 10)
			expect(ops).toHaveLength(2)

			const result = await unpinned.rotateNodeId(ops.map((op) => op.id))
			expect(result.nodeId).not.toBe(before)
			expect(unpinned.getNodeId()).toBe(result.nodeId)
			expect(result.operations.map((op) => op.sequenceNumber)).toEqual([1, 2])
			expect(result.operations.every((op) => op.timestamp.nodeId === result.nodeId)).toBe(true)
			// The update's causal dep follows its insert to the new id.
			expect(result.operations[1]?.causalDeps).toContain(result.operations[0]?.id)
			expect(await unpinned.getOperationRange(before, 1, 10)).toEqual([])
			expect(await unpinned.getOperationRange(result.nodeId, 1, 10)).toHaveLength(2)
			expect((await col.findById(a.id))?.title).toBe('a2')
			// New writes continue the new node's sequence.
			await col.insert({ title: 'b' })
			expect(unpinned.getVersionVector().get(result.nodeId)).toBe(3)
			await unpinned.close()
		})

		test('rotateNodeId refuses a pinned node id', async () => {
			await expect(store.rotateNodeId([])).rejects.toThrow('pinned node id')
		})

		describe.each(['fold', 'legacy'] as const)(
			'a remote operation whose delivery moved while the write waited (%s)',
			(materialization) => {
				test('writes nothing and rolls back with STALE_STORE_WRITE', async () => {
					const local = new Store({
						schema: minimalSchema,
						adapter: new BetterSqlite3Adapter(':memory:'),
						nodeId: 'device-node',
						materialization,
					})
					await local.open()
					const op: Operation = {
						id: 'stale-op',
						nodeId: 'remote',
						type: 'insert',
						collection: 'todos',
						recordId: 'stale-rec',
						data: { title: 'x' },
						previousData: null,
						timestamp: { wallTime: 1, logical: 0, nodeId: 'remote' },
						sequenceNumber: 1,
						causalDeps: [],
						schemaVersion: 1,
					}
					local.noteDeliveryPosition(op.id, { position: 3, replay: false, isCurrent: () => false })
					await expect(local.applyRemoteOperation(op)).rejects.toMatchObject({
						code: 'STALE_STORE_WRITE',
					})
					expect(await local.collection('todos').findById('stale-rec')).toBeNull()
					const logged = await (
						local as unknown as { adapter: { query(sql: string): Promise<unknown[]> } }
					).adapter.query("SELECT id FROM _kora_ops_todos WHERE id = 'stale-op'")
					expect(logged).toEqual([])
					await local.close()
				})
			},
		)

		describe.each(['fold', 'legacy'] as const)(
			'a remote operation whose delivery moved after the write started (%s)',
			(materialization) => {
				test('rolls back before the commit with STALE_STORE_WRITE', async () => {
					const local = new Store({
						schema: minimalSchema,
						adapter: new BetterSqlite3Adapter(':memory:'),
						nodeId: 'device-node',
						materialization,
					})
					await local.open()
					const op: Operation = {
						id: 'late-op',
						nodeId: 'remote',
						type: 'insert',
						collection: 'todos',
						recordId: 'late-rec',
						data: { title: 'x' },
						previousData: null,
						timestamp: { wallTime: 1, logical: 0, nodeId: 'remote' },
						sequenceNumber: 1,
						causalDeps: [],
						schemaVersion: 1,
					}
					// Current when the transaction starts, stale by the time it would commit.
					let asked = 0
					local.noteDeliveryPosition(op.id, {
						position: 3,
						replay: false,
						isCurrent: () => {
							asked++
							return asked < 2
						},
					})
					await expect(local.applyRemoteOperation(op)).rejects.toMatchObject({
						code: 'STALE_STORE_WRITE',
					})
					expect(asked).toBe(2)
					expect(await local.collection('todos').findById('late-rec')).toBeNull()
					const logged = await (
						local as unknown as { adapter: { query(sql: string): Promise<unknown[]> } }
					).adapter.query("SELECT id FROM _kora_ops_todos WHERE id = 'late-op'")
					expect(logged).toEqual([])
					await local.close()
				})
			},
		)

		describe.each(['fold', 'legacy'] as const)(
			'a record retracted before its insert applied stays hidden (%s)',
			(materialization) => {
				let local: Store
				beforeEach(async () => {
					local = new Store({
						schema: minimalSchema,
						adapter: new BetterSqlite3Adapter(':memory:'),
						nodeId: 'device-node',
						materialization,
					})
					await local.open()
				})
				afterEach(async () => {
					await local.close()
				})
				const insert = (recordId: string): Operation => ({
					id: `insert-${recordId}`,
					nodeId: 'author-node',
					type: 'insert',
					collection: 'todos',
					recordId,
					data: { title: 'Outside the view', completed: false },
					previousData: null,
					timestamp: { wallTime: 1_000, logical: 0, nodeId: 'author-node' },
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
				})

				// Visibility follows delivery order: the record's latest delivered operation or
				// its latest retraction, whichever comes later in the stream (RT-19).
				const at = (position: number): { deliveryPosition: number } => ({
					deliveryPosition: position,
				})
				const visible = async (id: string): Promise<boolean> =>
					(await local.collection('todos').findById(id)) !== null

				test('an insert delivered before its retraction, replayed later, stays hidden', async () => {
					// The insert (sequence 5) was quarantined; the retraction (sequence 7) found
					// no row. The quarantine replay must not show the record.
					await local.applyScopeRetraction('todos', 'q', 7)
					expect(await local.applyRemoteOperation(insert('q'), at(5))).toBe('applied')
					expect(await visible('q')).toBe(false)
					expect(await local.collection('todos').where({}).exec()).toEqual([])
				})

				test('an insert delivered after the retraction shows the record (server re-entry)', async () => {
					// The server put the record back into the view with an insert onto the
					// existing record (an explicit-id write): no scope entry, still shown.
					await local.applyRemoteOperation(insert('back'), at(3))
					await local.applyScopeRetraction('todos', 'back', 5)
					expect(await visible('back')).toBe(false)
					const reinsert: Operation = {
						...insert('back'),
						id: 'reinsert-back',
						data: { title: 'Back in view', completed: false },
						timestamp: { wallTime: 2_000, logical: 0, nodeId: 'author-node' },
						sequenceNumber: 2,
					}
					expect(await local.applyRemoteOperation(reinsert, at(9))).toBe('applied')
					expect(await local.collection('todos').findById('back')).toMatchObject({
						title: 'Back in view',
					})
				})

				test('an update delivered after the retraction shows the record', async () => {
					await local.applyRemoteOperation(insert('upd'), at(3))
					await local.applyScopeRetraction('todos', 'upd', 5)
					await local.applyRemoteOperation(
						{
							...insert('upd'),
							id: 'update-upd',
							type: 'update',
							data: { title: 'Edited' },
							previousData: { title: 'Outside the view' },
							timestamp: { wallTime: 3_000, logical: 0, nodeId: 'author-node' },
							sequenceNumber: 2,
						},
						at(8),
					)
					expect(await local.collection('todos').findById('upd')).toMatchObject({ title: 'Edited' })
				})

				test("an update after the retraction does not undo this device's own newer delete", async () => {
					// The marker sits on a row this device deleted: lifting the retraction's hide
					// must leave the domain delete in force (it is newer than the update).
					await local.applyRemoteOperation(insert('del'), at(3))
					await local.collection('todos').delete('del')
					await local.applyScopeRetraction('todos', 'del', 5)
					const update = (id: string, wallTime: number): Operation => ({
						...insert('del'),
						id,
						type: 'update',
						data: { title: 'y' },
						previousData: { title: 'Outside the view' },
						timestamp: { wallTime, logical: 0, nodeId: 'author-node' },
						sequenceNumber: 2,
					})
					await local.applyRemoteOperation(update('older-update-del', 3_000), at(8))
					expect(await visible('del')).toBe(false)
					// A re-delivery of it after a later retraction does not show it either.
					await local.applyScopeRetraction('todos', 'del', 9)
					await local.applyRemoteOperation(update('older-update-del', 3_000), at(10))
					expect(await visible('del')).toBe(false)
				})

				test('a duplicate delete re-delivered after the retraction keeps the record deleted', async () => {
					await local.applyRemoteOperation(insert('dd'), at(3))
					const remove: Operation = {
						...insert('dd'),
						id: 'delete-dd',
						type: 'delete',
						data: null,
						previousData: null,
						timestamp: { wallTime: 2_000, logical: 0, nodeId: 'author-node' },
						sequenceNumber: 2,
					}
					expect(await local.applyRemoteOperation(remove, at(4))).toBe('applied')
					await local.applyScopeRetraction('todos', 'dd', 5)
					expect(await local.applyRemoteOperation(remove, at(8))).toBe('duplicate')
					expect(await visible('dd')).toBe(false)
				})

				test('a duplicate re-delivery of an earlier operation does not show the record', async () => {
					await local.applyRemoteOperation(insert('dup'), at(3))
					await local.applyScopeRetraction('todos', 'dup', 5)
					expect(await local.applyRemoteOperation(insert('dup'), at(3))).toBe('duplicate')
					expect(await visible('dup')).toBe(false)
					// Without a position (a relay re-send, an older server) it stays hidden too.
					expect(await local.applyRemoteOperation(insert('dup'))).toBe('duplicate')
					expect(await visible('dup')).toBe(false)
				})

				test('a re-sent earlier retraction never moves the marker back', async () => {
					await local.applyRemoteOperation(insert('mv'), at(3))
					await local.applyScopeRetraction('todos', 'mv', 9)
					await local.applyScopeRetraction('todos', 'mv', 5)
					await local.applyRemoteOperation(
						{ ...insert('mv'), id: 'late-mv', sequenceNumber: 2 },
						at(7),
					)
					expect(await visible('mv')).toBe(false)
				})

				test('a scope entry shares its trigger sequence and comes after a retraction there', async () => {
					await local.applyRemoteOperation(insert('en'), at(3))
					await local.applyScopeRetraction('todos', 'en', 6)
					const entry: Operation = {
						...insert('en'),
						id: 'scope-entry-en',
						nodeId: 'kora:scope-entry',
						sequenceNumber: 0,
						data: { title: 'Entered', completed: false },
						timestamp: { wallTime: 2_500, logical: 0, nodeId: 'kora:scope-entry' },
					}
					await local.applyRemoteOperation(entry, at(6.5))
					expect(await local.collection('todos').findById('en')).toMatchObject({ title: 'Entered' })
				})

				test('a restarted delivery run lets its operations show the record', async () => {
					// Hidden at 50 in an earlier run; the stream restarts from 0 (another view, a
					// forced full resync): the new run's operations decide.
					await local.applyScopeRetraction('todos', 'run', 50)
					await local.rebaseDeliveryRun(0)
					await local.applyRemoteOperation(insert('run'), at(4))
					expect(await visible('run')).toBe(true)
				})

				test('a resumed run moves nothing', async () => {
					await local.applyScopeRetraction('todos', 'res', 7)
					await local.rebaseDeliveryRun(7)
					await local.applyRemoteOperation(insert('res'), at(5))
					expect(await visible('res')).toBe(false)
				})

				test('without delivery positions, the earlier rule holds', async () => {
					// A marker without a position (an older client's, or a relay): a new insert or
					// a scope entry shows the record, an update or a duplicate does not.
					await local.applyRemoteOperation(insert('old'), at(3))
					await local.applyScopeRetraction('todos', 'old')
					await local.applyRemoteOperation({
						...insert('old'),
						id: 'update-old',
						type: 'update',
						data: { title: 'Edited' },
						previousData: { title: 'Outside the view' },
						timestamp: { wallTime: 3_000, logical: 0, nodeId: 'author-node' },
						sequenceNumber: 2,
					})
					expect(await visible('old')).toBe(false)
					await local.applyRemoteOperation(insert('old'))
					expect(await visible('old')).toBe(false)
					await local.applyRemoteOperation({
						...insert('old'),
						id: 'reinsert-old',
						sequenceNumber: 3,
					})
					expect(await visible('old')).toBe(true)
				})
			},
		)

		test('an insert for a retracted row shows it again and merges per field (RT-19)', async () => {
			const col = store.collection('todos')
			const record = await col.insert({ title: 'Stale copy' })
			await store.applyScopeRetraction('todos', record.id)

			// A scope-entry insert stamped before the local write loses that field's LWW
			// comparison only where this device is newer; here it is newer than the row.
			const entry: Operation = {
				id: 'scope-entry-test',
				nodeId: 'kora:scope-entry',
				type: 'insert',
				collection: 'todos',
				recordId: record.id,
				data: { title: 'Current title', completed: true },
				previousData: null,
				timestamp: { wallTime: Date.now() + 1000, logical: 0, nodeId: 'remote' },
				sequenceNumber: 0,
				causalDeps: [],
				schemaVersion: 1,
			}
			expect(await store.applyRemoteOperation(entry)).toBe('applied')
			expect(await col.findById(record.id)).toMatchObject({
				title: 'Current title',
				completed: true,
			})
			// The system node never enters the version vector (sequence 0).
			expect(store.getVersionVector().get('kora:scope-entry')).toBeUndefined()
		})

		describe('scope-entry insert with per-field versions (RT-27)', () => {
			const created = { wallTime: 1_000, logical: 0, nodeId: 'origin' }
			function scopeEntry(
				recordId: string,
				fieldVersions: Operation['fieldVersions'],
				id = 'scope-entry-rt27',
			): Operation {
				return {
					id,
					nodeId: 'kora:scope-entry',
					type: 'insert',
					collection: 'todos',
					recordId,
					data: { title: 'server title', completed: true },
					previousData: null,
					timestamp: created,
					sequenceNumber: 0,
					causalDeps: [],
					schemaVersion: 1,
					fieldVersions,
				}
			}

			test('keeps a newer local field and takes a newer server field', async () => {
				const col = store.collection('todos')
				const record = await col.insert({ title: 'first' })
				await col.update(record.id, { title: 'my offline edit' })
				const later = { wallTime: Date.now() + 1_000, logical: 0, nodeId: 'server' }
				const entry = scopeEntry(record.id, { title: created, completed: later })
				expect(await store.applyRemoteOperation(entry)).toBe('applied')
				expect(await col.findById(record.id)).toMatchObject({
					title: 'my offline edit',
					completed: true,
				})
				// Idempotent: the same entry again is a no-op.
				expect(await store.applyRemoteOperation(entry)).toBe('duplicate')
				expect((await col.findById(record.id))?.title).toBe('my offline edit')
				// The clock moved past every version the entry carried.
				const local = await col.update(record.id, { completed: false })
				expect(local.completed).toBe(false)
			})

			test('a fresh row gets each field at its own version and the real createdAt', async () => {
				const col = store.collection('todos')
				const id = generateUUIDv7()
				const later = { wallTime: Date.now() + 1_000, logical: 0, nodeId: 'server' }
				expect(
					await store.applyRemoteOperation(scopeEntry(id, { title: created, completed: later })),
				).toBe('applied')
				const row = await col.findById(id)
				expect(row).toMatchObject({ title: 'server title', completed: true })
				expect(row?.createdAt).toBe(created.wallTime)
				// A remote update older than `completed`'s version loses; newer than title wins.
				const mid = { wallTime: Date.now(), logical: 0, nodeId: 'peer' }
				await store.applyRemoteOperation({
					...scopeEntry(id, undefined, 'peer-update'),
					nodeId: 'peer',
					type: 'update',
					data: { title: 'peer title', completed: false },
					previousData: { title: 'server title', completed: true },
					timestamp: mid,
					sequenceNumber: 1,
				})
				expect(await col.findById(id)).toMatchObject({ title: 'peer title', completed: true })
			})

			test('a newer domain delete is not revived by an older entry', async () => {
				const col = store.collection('todos')
				const record = await col.insert({ title: 'x' })
				await col.delete(record.id)
				const entry = scopeEntry(record.id, { title: created, completed: created })
				await store.applyRemoteOperation(entry)
				expect(await col.findById(record.id)).toBeNull()
			})
		})

		test('where query', async () => {
			const col = store.collection('todos')
			await col.insert({ title: 'A', completed: true })
			await col.insert({ title: 'B' })

			const results = await col.where({ completed: false }).exec()
			expect(results).toHaveLength(1)
			expect(results[0]?.title).toBe('B')
		})
	})

	describe('version vector', () => {
		test('updates after mutations', async () => {
			const col = store.collection('todos')
			await col.insert({ title: 'VV test 1' })
			await col.insert({ title: 'VV test 2' })

			const vv = store.getVersionVector()
			expect(vv.get('test-node')).toBe(2)
		})
	})

	describe('applyRemoteOperation', () => {
		async function createRemoteOp(overrides: Partial<Operation> = {}): Promise<Operation> {
			const clock = new HybridLogicalClock('remote-node')
			return createOperation(
				{
					nodeId: 'remote-node',
					type: 'insert',
					collection: 'todos',
					recordId: generateUUIDv7(),
					data: { title: 'Remote todo', completed: false },
					previousData: null,
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
					...overrides,
				},
				clock,
			)
		}

		test('applies a remote insert', async () => {
			const op = await createRemoteOp()
			const result = await store.applyRemoteOperation(op)
			expect(result).toBe('applied')

			const col = store.collection('todos')
			const found = await col.findById(op.recordId)
			expect(found).not.toBeNull()
			expect(found?.title).toBe('Remote todo')
		})

		test('deduplicates by operation id', async () => {
			const op = await createRemoteOp()
			await store.applyRemoteOperation(op)
			const result = await store.applyRemoteOperation(op)
			expect(result).toBe('duplicate')
		})

		test('skips operations for unknown collections', async () => {
			const clock = new HybridLogicalClock('remote-node')
			const op = await createOperation(
				{
					nodeId: 'remote-node',
					type: 'insert',
					collection: 'nonexistent',
					recordId: generateUUIDv7(),
					data: { title: 'Bad' },
					previousData: null,
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
				},
				clock,
			)
			const result = await store.applyRemoteOperation(op)
			expect(result).toBe('skipped')
		})

		test('updates version vector for remote node', async () => {
			const op = await createRemoteOp({ sequenceNumber: 5 })
			await store.applyRemoteOperation(op)

			const vv = store.getVersionVector()
			expect(vv.get('remote-node')).toBe(5)
		})

		test('applies remote update', async () => {
			// First insert locally
			const col = store.collection('todos')
			const record = await col.insert({ title: 'Local' })

			// Remote op must be HLC-newer than the materialized row to pass LWW guard
			const clock = new HybridLogicalClock('remote-node')
			clock.receive({
				wallTime: record.updatedAt,
				logical: 0,
				nodeId: store.getNodeId(),
			})

			const op = await createOperation(
				{
					nodeId: 'remote-node',
					type: 'update',
					collection: 'todos',
					recordId: record.id,
					data: { title: 'Updated remotely' },
					previousData: { title: 'Local' },
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
				},
				clock,
			)

			await store.applyRemoteOperation(op)

			const found = await col.findById(record.id)
			expect(found?.title).toBe('Updated remotely')
		})

		test('applies remote delete', async () => {
			const col = store.collection('todos')
			const record = await col.insert({ title: 'To remote delete' })

			const clock = new HybridLogicalClock('remote-node')
			clock.receive({
				wallTime: record.updatedAt,
				logical: 0,
				nodeId: store.getNodeId(),
			})

			const op = await createOperation(
				{
					nodeId: 'remote-node',
					type: 'delete',
					collection: 'todos',
					recordId: record.id,
					data: null,
					previousData: null,
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
				},
				clock,
			)

			await store.applyRemoteOperation(op)

			const found = await col.findById(record.id)
			expect(found).toBeNull()
		})
	})

	describe('getOperationRange', () => {
		test('returns operations for a node within range', async () => {
			const col = store.collection('todos')
			await col.insert({ title: 'Op 1' })
			await col.insert({ title: 'Op 2' })
			await col.insert({ title: 'Op 3' })

			const ops = await store.getOperationRange('test-node', 1, 3)
			expect(ops).toHaveLength(3)
			expect(ops[0]?.sequenceNumber).toBe(1)
			expect(ops[2]?.sequenceNumber).toBe(3)
		})

		test('returns subset when range is partial', async () => {
			const col = store.collection('todos')
			await col.insert({ title: 'Op 1' })
			await col.insert({ title: 'Op 2' })
			await col.insert({ title: 'Op 3' })

			const ops = await store.getOperationRange('test-node', 2, 3)
			expect(ops).toHaveLength(2)
			expect(ops[0]?.sequenceNumber).toBe(2)
		})

		test('returns empty for non-existent node', async () => {
			const ops = await store.getOperationRange('unknown-node', 1, 10)
			expect(ops).toEqual([])
		})

		test('includes collection name on deserialized operations', async () => {
			const col = store.collection('todos')
			await col.insert({ title: 'Named op' })

			const ops = await store.getOperationRange('test-node', 1, 1)
			expect(ops[0]?.collection).toBe('todos')
		})
	})

	describe('getLatestOperationForRecord', () => {
		test('returns op with greatest HLC across all nodes', async () => {
			const recordId = 'rec-latest-op-test'
			const localInsert = {
				id: 'local-insert-op-id',
				nodeId: 'test-node',
				type: 'insert' as const,
				collection: 'todos',
				recordId,
				data: { title: 'Local', completed: false },
				previousData: null,
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'test-node' },
				sequenceNumber: 1,
				causalDeps: [] as string[],
				schemaVersion: 1,
			}
			await store.applyRemoteOperation(localInsert)

			const remoteUpdate = {
				id: 'remote-update-op-id',
				nodeId: 'remote-node',
				type: 'update' as const,
				collection: 'todos',
				recordId,
				data: { title: 'Remote later' },
				previousData: { title: 'Local', completed: false },
				timestamp: { wallTime: 5000, logical: 0, nodeId: 'remote-node' },
				sequenceNumber: 1,
				causalDeps: [] as string[],
				schemaVersion: 1,
			}
			await store.applyRemoteOperation(remoteUpdate)

			const latest = await store.getLatestOperationForRecord('todos', recordId)
			expect(latest?.nodeId).toBe('remote-node')
			expect(latest?.type).toBe('update')
		})
	})
})
