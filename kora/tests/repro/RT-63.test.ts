/**
 * RT-63 repro (Phase 3 red team, 2026-10-02): the client fold has no plan fingerprint.
 *
 * A device re-materializes once per database (`fold_materialization = fold-v1`). When
 * a later schema changes how a field folds (here a number becomes
 * `merge('counter')`; also an array becoming `append-only`, a field gaining a resolver
 * or changing kind in a migration), every stored record keeps a fold state of the old
 * kind, and `mergeOp` throws `FoldStateError` for every later write to that field of
 * an existing record: local writes fail, and remote operations fail to apply on every
 * upgraded device. The server stores re-fold on a plan change
 * (`fold_plan_fingerprint`); the client never does.
 *
 * Asserts the CORRECT behaviour (fails at 959b791): after the upgrade, writes to the
 * re-planned field succeed and fold with the new plan.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, migrate, t } from '@korajs/core'
import { afterAll, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'

const dir = mkdtempSync(join(tmpdir(), 'rt-63-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('changing a field to merge("counter") keeps existing records writable', async () => {
	const path = join(dir, 'db.db')
	const v1 = defineSchema({
		version: 1,
		collections: { items: { fields: { title: t.string(), score: t.number().default(0) } } },
	})
	const a = createApp({ schema: v1, store: { adapter: 'better-sqlite3', name: path } })
	await a.ready
	const itemsA = (a as unknown as Record<string, any>).items
	const item = await itemsA.insert({ title: 'x', score: 1 })
	await itemsA.update(item.id, { score: 2 })
	await a.close()

	const v2 = defineSchema({
		version: 2,
		collections: {
			items: { fields: { title: t.string(), score: t.number().default(0).merge('counter') } },
		},
		migrations: { 2: migrate().backfill('items', () => ({})) },
	})
	const b = createApp({ schema: v2, store: { adapter: 'better-sqlite3', name: path } })
	await b.ready
	const itemsB = (b as unknown as Record<string, any>).items
	let error: unknown = null
	try {
		await itemsB.update(item.id, { score: 5 })
	} catch (e) {
		error = e
	}
	expect(error).toBeNull()
	expect(await itemsB.findById(item.id)).toMatchObject({ score: 5 })
	await b.close()
})
