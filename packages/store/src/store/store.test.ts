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
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { fullSchema, minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { StampedFieldError, StoreNotOpenError } from '../errors'
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

			test('a collection without access rules is retracted at once', async () => {
				const s = await open('ann')
				expect(await s.deferScopeRetraction('plain', 'p1')).toBe(false)
				await s.close()
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
