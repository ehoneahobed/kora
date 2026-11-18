import 'fake-indexeddb/auto'
import { defineSchema, t } from '@korajs/core'
import type { CollectionRecord, QueryBuilder } from '@korajs/store'
import { afterEach, describe, expect, test } from 'vitest'
import { createBlobApi } from './blob/create-blob-api'
import { createApp } from './create-app'
import { DeferredQueryBuilder } from './deferred-query'
import { createSequencesAccessor } from './sequences-accessor'
import { createTransactionExecutor } from './transaction-executor'
import type { KoraConfig } from './types'

/**
 * Runtime errors a developer can hit carry a KoraError code and a fix hint, so code can tell
 * them apart (error.code) and the message says what to do, instead of plain Errors.
 */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

async function codeOf(run: () => unknown): Promise<{ code?: string; fix?: string }> {
	try {
		await run()
	} catch (error) {
		const e = error as { code?: string; context?: { fix?: string } }
		return { code: e.code, fix: e.context?.fix }
	}
	throw new Error('expected a throw')
}

let app: ReturnType<typeof createApp> | null = null
afterEach(async () => {
	await app?.close?.()
	app = null
})

describe('korajs runtime errors have codes', () => {
	test('sequences before the store exists: APP_NOT_READY', async () => {
		const sequences = createSequencesAccessor(Promise.resolve(), () => null)
		expect(await codeOf(() => sequences.next('invoice'))).toMatchObject({
			code: 'APP_NOT_READY',
			fix: expect.any(String),
		})
	})

	test('a transaction before the store exists: APP_NOT_READY', async () => {
		const transaction = createTransactionExecutor(
			{ schema } as KoraConfig,
			Promise.resolve(),
			() => null,
		)
		expect(await codeOf(() => transaction(async () => {}))).toMatchObject({ code: 'APP_NOT_READY' })
	})

	test('app.getStore() and app.blobs.store before ready: APP_NOT_READY', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		const early = app
		expect(await codeOf(() => early.getStore())).toMatchObject({ code: 'APP_NOT_READY' })
		expect(await codeOf(() => early.blobs.store)).toMatchObject({ code: 'APP_NOT_READY' })
		await early.ready
	})

	test('a query whose store did not open: APP_OPEN_FAILED, pointing at app.ready', async () => {
		const query = new DeferredQueryBuilder('todos', {
			whenReady: () => Promise.resolve(),
			resolve: () => null as unknown as QueryBuilder<CollectionRecord> | null,
		})
		expect(await codeOf(() => query.exec())).toMatchObject({
			code: 'APP_OPEN_FAILED',
			fix: expect.stringContaining('app.ready'),
		})
	})

	test('pulling blob bytes without a sync connection: BLOB_SYNC_UNAVAILABLE', async () => {
		const blobs = createBlobApi(
			{} as Parameters<typeof createBlobApi>[0],
			null,
			undefined,
			async () => [],
		)
		const manifest = {
			blobHash: 'a'.repeat(64),
			size: 1,
			chunkSize: 1,
			chunkHashes: ['b'.repeat(64)],
		}
		expect(
			await codeOf(() => blobs.pull(manifest as Parameters<typeof blobs.pull>[0])),
		).toMatchObject({ code: 'BLOB_SYNC_UNAVAILABLE', fix: expect.any(String) })
	})
})
