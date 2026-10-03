/**
 * RT-65 client half: the client SQLite store keeps every JavaScript string. better-sqlite3
 * binds strings as UTF-8, which turns a lone surrogate into U+FFFD; raw-string columns use
 * the shared stored-text codec (`@korajs/core`), the same escaping as the server stores.
 * The real-browser WASM paths (OPFS and the IndexedDB fallback) are checked by
 * tests/repro/browser/LMS-5-6-7.browser.mjs (scenario RT-65).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import { STORED_TEXT_CODEC_META_KEY } from './stored-text-migration'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		notes: {
			fields: {
				title: t.string(),
				projectId: t.string().optional(),
				kind: t.enum(['a', 'b']).default('a'),
				tags: t.array(t.string()).default([]),
				meta: t.object({ label: t.string() }).optional(),
			},
		},
	},
	relations: {
		noteProject: {
			from: 'notes',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
	},
}) as unknown as SchemaDefinition

const POISON = ['pasted\u0000text', 'cut emoji \ud83d', '\ude00 low', 'escape ￿0', 'ok 😀']
const dir = mkdtempSync(join(tmpdir(), 'kora-stored-text-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function openStore(file: string): Promise<Store> {
	const store = new Store({ schema, adapter: new BetterSqlite3Adapter(file) })
	await store.open()
	return store
}

describe('client store string fidelity (RT-65)', () => {
	test('rows, filters and the op log keep NUL, lone surrogates and U+FFFF across a reopen', async () => {
		const file = join(dir, 'roundtrip.db')
		let store = await openStore(file)
		const ids: string[] = []
		for (const s of POISON) {
			const rec = await store
				.collection('notes')
				.insert({ title: s, tags: [s, 'x'], meta: { label: s } })
			expect(rec.title).toBe(s)
			ids.push(String(rec.id))
		}
		await store.close()
		store = await openStore(file)
		try {
			const notes = store.collection('notes')
			for (let i = 0; i < POISON.length; i++) {
				const s = POISON[i] as string
				const rec = await notes.findById(ids[i] as string)
				expect(rec).toMatchObject({ title: s, tags: [s, 'x'], meta: { label: s } })
				const eq = await notes.where({ title: s }).exec()
				expect(eq.map((r) => r.id)).toEqual([ids[i]])
				const inn = await notes.where({ title: { $in: [s, 'other'] } }).exec()
				expect(inn.map((r) => r.id)).toEqual([ids[i]])
				const ne = await notes.where({ title: { $ne: s } }).exec()
				expect(ne).toHaveLength(POISON.length - 1)
			}
			const ops = await store.getAllOperations()
			for (const s of POISON) {
				expect(ops.some((op) => op.data?.title === s && (op.data?.tags as string[])[0] === s)).toBe(
					true,
				)
			}
		} finally {
			await store.close()
		}
	})

	test('an update and a fold re-materialization keep the value', async () => {
		const store = await openStore(':memory:')
		try {
			const notes = store.collection('notes')
			const rec = await notes.insert({ title: 'plain' })
			await notes.update(String(rec.id), { title: 'x\ud800y' })
			expect((await notes.findById(String(rec.id)))?.title).toBe('x\ud800y')
		} finally {
			await store.close()
		}
	})

	test('a cascade still finds its children through the (codec-bound) foreign key lookup', async () => {
		const store = await openStore(':memory:')
		try {
			const project = await store.collection('projects').insert({ name: 'p' })
			const note = await store
				.collection('notes')
				.insert({ title: 'n', projectId: String(project.id) })
			await store.collection('projects').delete(String(project.id))
			expect(await store.collection('notes').findById(String(note.id))).toBeNull()
		} finally {
			await store.close()
		}
	})

	test('rows written before the codec keep their U+FFFF (one-time re-encode)', async () => {
		const file = join(dir, 'legacy.db')
		let store = await openStore(file)
		const rec = await store.collection('notes').insert({ title: 'seed' })
		await store.close()
		// Simulate a pre-codec database: a raw U+FFFF followed by a tag letter, and no meta.
		const raw = new BetterSqlite3Adapter(file)
		await raw.open(schema)
		await raw.execute('UPDATE notes SET title = ? WHERE id = ?', ['legacy ￿0 ￿s', rec.id])
		await raw.execute('DELETE FROM _kora_meta WHERE key = ?', [STORED_TEXT_CODEC_META_KEY])
		await raw.close()
		store = await openStore(file)
		try {
			expect((await store.collection('notes').findById(String(rec.id)))?.title).toBe('legacy ￿0 ￿s')
		} finally {
			await store.close()
		}
		// Idempotent: a second open does not re-encode again.
		store = await openStore(file)
		try {
			expect((await store.collection('notes').findById(String(rec.id)))?.title).toBe('legacy ￿0 ￿s')
		} finally {
			await store.close()
		}
	})
})
