import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import { quiesce, useSynchronousDigest } from './test-support'

useSynchronousDigest()

/**
 * A delete's cascades write other records, so a write called after it must not reach storage
 * before it, whatever record it touches. The owner is cold (its delete would read), the pet
 * is warm (a later update of it would not): with the flag on, the log and the outcome of the
 * unawaited `delete(owner); update(pet)` must be the flag-off ones, for a plain delete and for
 * a transaction, with `cascade` and with `set-null`.
 */
function schemaFor(onDelete: 'cascade' | 'set-null') {
	return defineSchema({
		version: 1,
		collections: {
			owners: { fields: { name: t.string() } },
			pets: { fields: { name: t.string(), ownerId: t.string().optional() } },
		},
		relations: {
			petOwner: { from: 'pets', to: 'owners', type: 'many-to-one', field: 'ownerId', onDelete },
		},
	})
}

type Style = 'delete' | 'transaction'

async function run(
	file: string,
	instant: boolean,
	onDelete: 'cascade' | 'set-null',
	style: Style,
	ids: { owner: string; pet: string },
) {
	const schema = schemaFor(onDelete)
	const adapter = new BetterSqlite3Adapter(file)
	const emitter = new SimpleEventEmitter()
	const ops: Operation[] = []
	emitter.on('operation:created', (event) => ops.push(event.operation))
	const store = new Store({
		schema,
		adapter,
		nodeId: 'cascade-node',
		emitter,
		...(instant
			? {
					instantUpdates: true,
					instantUpdatesInternals: { strict: false, baseReadTimeoutMs: 3_600_000 },
				}
			: {}),
	})
	await store.open()
	// Warm the pet: the registry knows it, so its update needs no read.
	await store.collection('pets').update(ids.pet, { name: 'warm' })
	await quiesce()
	ops.length = 0
	const removal =
		style === 'delete'
			? store.collection('owners').delete(ids.owner)
			: store.transaction(async (tx) => {
					await tx.collection('owners').delete(ids.owner)
				})
	const update = store.collection('pets').update(ids.pet, { name: 'after' })
	const settled = await Promise.allSettled([removal, update])
	await quiesce()
	const pet = await store.collection('pets').findById(ids.pet)
	await store.close()
	return {
		log: ops.map(
			(op) =>
				`${op.sequenceNumber}:${op.collection}.${op.type}.${op.recordId === ids.owner ? 'owner' : 'pet'}`,
		),
		outcomes: settled.map((one) => one.status),
		pet: pet ? { name: pet.name, ownerId: pet.ownerId ?? null } : null,
	}
}

describe('a delete is a barrier for the writes called after it', () => {
	for (const onDelete of ['cascade', 'set-null'] as const) {
		for (const style of ['delete', 'transaction'] as const) {
			test(`${style} of a cold owner, then update of a warm pet (${onDelete}): same log and outcome as off`, async () => {
				const dir = mkdtempSync(join(tmpdir(), 'kora-cascade-'))
				try {
					const schema = schemaFor(onDelete)
					const base = join(dir, 'base.db')
					const seeding = new Store({
						schema,
						adapter: new BetterSqlite3Adapter(base),
						nodeId: 'cascade-node',
					})
					await seeding.open()
					const owner = await seeding.collection('owners').insert({ name: 'o' })
					const pet = await seeding.collection('pets').insert({ name: 'p', ownerId: owner.id })
					await seeding.close()
					const offFile = join(dir, 'off.db')
					const onFile = join(dir, 'on.db')
					copyFileSync(base, offFile)
					copyFileSync(base, onFile)
					const ids = { owner: owner.id, pet: pet.id }
					const off = await run(offFile, false, onDelete, style, ids)
					const on = await run(onFile, true, onDelete, style, ids)
					expect(on.log).toEqual(off.log)
					expect(on.outcomes).toEqual(off.outcomes)
					expect(on.pet).toEqual(off.pet)
				} finally {
					rmSync(dir, { recursive: true, force: true })
				}
			})
		}
	}
})
