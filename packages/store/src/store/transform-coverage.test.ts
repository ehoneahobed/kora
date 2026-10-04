import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type OperationTransform,
	OperationTransformCoverageError,
	defineSchema,
	t,
} from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from './store'

/** RT-103: a device refuses to open with transforms that cannot read its operation log. */
const fields = { title: t.string() }
const v1 = defineSchema({ version: 1, collections: { notes: { fields } } })
const v3 = defineSchema({ version: 3, collections: { notes: { fields } } })
const step = (fromVersion: number, toVersion: number): OperationTransform => ({
	fromVersion,
	toVersion,
	transform: (op) => ({ ...op, schemaVersion: toVersion }),
})

describe('Store.open transform coverage (RT-103)', () => {
	let dir: string | null = null
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true })
		dir = null
	})

	test('refuses retired transforms, opens with the full chain or none', async () => {
		dir = mkdtempSync(join(tmpdir(), 'rt103-store-'))
		const file = join(dir, 'a.db')
		const first = new Store({ schema: v1, adapter: new BetterSqlite3Adapter(file) })
		await first.open()
		const row = await first.collection('notes').insert({ title: 'v1 note' })
		await first.close()

		const retired = new Store({
			schema: v3,
			adapter: new BetterSqlite3Adapter(file),
			operationTransforms: [step(2, 3)],
		})
		const error = await retired.open().then(
			() => null,
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(OperationTransformCoverageError)
		expect((error as OperationTransformCoverageError).versions).toEqual([1])
		expect((error as Error).message).toContain('local database')
		await retired.close().catch(() => {})

		const full = new Store({
			schema: v3,
			adapter: new BetterSqlite3Adapter(file),
			operationTransforms: [step(1, 2), step(2, 3)],
		})
		await full.open()
		expect(await full.collection('notes').findById(String(row.id))).toMatchObject({
			title: 'v1 note',
		})
		await full.close()
	})
})
