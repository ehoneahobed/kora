import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type OfflineStatus, defineSchema, t } from '@korajs/core'
import type { CollectionAccessor } from '@korajs/store'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createApp } from './create-app'
import type { KoraApp } from './types'

/**
 * `app.offline.keep()` through `createApp`: the sync engine is created only after the pins
 * are read, so the pins must still reach it, and its connection must still retry kept files.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		lessons: {
			fields: { title: t.string(), courseId: t.string(), video: t.blob().optional() },
		},
	},
})

const dirs: string[] = []
let app: KoraApp | null = null

afterEach(async () => {
	await app?.close()
	app = null
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function openApp(name: string): KoraApp {
	app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name },
		sync: { url: 'ws://localhost:65535/kora-sync', autoConnect: false },
	})
	return app
}

/** Resolves when the app's offline status satisfies `predicate` (the test timeout bounds it). */
function until(target: KoraApp, predicate: (status: OfflineStatus) => boolean): Promise<void> {
	return new Promise<void>((resolve) => {
		let off: () => void = () => {}
		const check = (): void => {
			if (predicate(target.offline.status())) {
				off()
				resolve()
			}
		}
		off = target.offline.subscribe(check)
		check()
	})
}

const course = (id: string) => ({
	getDescriptor: () => ({ collection: 'lessons', where: { courseId: id } }),
})

describe('app.offline.keep through createApp', () => {
	test('a pin kept in an earlier session joins the sync view of the engine that appears after load', async () => {
		const name = join(mkdtempSync(join(tmpdir(), 'kora-keep-')), 'app')
		dirs.push(join(name, '..'))

		let first = openApp(name)
		await first.ready
		await first.offline.keep(course('b'))
		await first.close()

		// Restart: the pin is read while the engine does not exist yet.
		first = openApp(name)
		await first.ready
		const engine = first.getSyncEngine()
		expect(engine).not.toBeNull()
		engine?.registerQuerySubset({ collection: 'lessons', where: { courseId: 'a' } })
		await vi.waitFor(() => {
			const views = engine?.getActiveQuerySubsets().map((s) => JSON.stringify(s.where))
			expect(views).toContain(JSON.stringify({ courseId: 'b' }))
			expect(views).toContain(JSON.stringify({ courseId: 'a' }))
		})

		// Keeping the same query again is a no-op and must not hide that the engine has it.
		await first.offline.keep(course('b'))
		expect(engine?.getActiveQuerySubsets()).toHaveLength(2)
	})

	test('kept files left missing by an interrupted download are looked at again when the connection changes', async () => {
		const name = join(mkdtempSync(join(tmpdir(), 'kora-keep-files-')), 'app')
		dirs.push(join(name, '..'))

		const first = openApp(name)
		await first.ready
		const bytes = new Uint8Array([1, 2, 3, 4, 5])
		const { ref } = await first.blobs.put(bytes, { filename: 'v.mp4' })
		await ((first as Record<string, unknown>).lessons as CollectionAccessor).insert({
			title: 'l',
			courseId: 'c1',
			video: ref,
		})
		// The download never finished: the bytes are not here.
		await first.blobs.delete(ref.hash)
		await first.close()

		const second = openApp(name)
		await second.ready
		await second.offline.keep(course('c1'), { files: true })
		// Not connected (there is no server): the pins are looked at once, the file is missing and
		// nothing is downloading. Waited for on the status, not on a timer.
		await until(second, (status) => status.reasons.includes('files-missing'))
		expect(second.offline.status().files.missing).toBe(1)
		// The download finishes some other way (another tab, a manual put) without any
		// change to the pins or the records.
		await second.blobs.put(bytes)

		// The engine's connection changes (it tries to connect): the fetch is retried.
		await second.sync?.connect().catch(() => undefined)
		await until(second, (status) => status.files.missing === 0)
		expect(await second.blobs.has(ref.hash)).toBe(true)
	})
})
