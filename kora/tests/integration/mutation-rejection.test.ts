/**
 * D7: a write made through a binding's mutation controller is reported to it when the
 * sync server refuses it, through the real store write path, sync engine and server.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { type MutationRejection, createMutationController } from '@korajs/core/bindings'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { KoraSyncServer, MemoryServerStore } from '../../../packages/server/src/index'
import { createServerTransportPair } from '../../../packages/server/src/internal'

let server: KoraSyncServer

class MemoryTransport implements SyncTransport {
	private inner: ReturnType<typeof createServerTransportPair>['client'] | null = null
	private onMsg: (m: SyncMessage) => void = () => {}
	private onCls: (r: string) => void = () => {}
	private onErr: (e: Error) => void = () => {}
	async connect(): Promise<void> {
		const pair = createServerTransportPair()
		this.inner = pair.client
		pair.client.onMessage((m) => this.onMsg(m))
		pair.client.onClose((r) => this.onCls(r))
		pair.client.onError((e) => this.onErr(e))
		server.handleConnection(pair.server)
	}
	async disconnect(): Promise<void> {
		await this.inner?.disconnect()
	}
	send(message: SyncMessage): void {
		if (!this.inner) throw new Error('not connected')
		this.inner.send(message)
	}
	onMessage(h: (m: SyncMessage) => void): void {
		this.onMsg = h
	}
	onClose(h: (r: string) => void): void {
		this.onCls = h
	}
	onError(h: (e: Error) => void): void {
		this.onErr = h
	}
	isConnected(): boolean {
		return this.inner?.isConnected() ?? false
	}
}

vi.mock('../../src/create-sync-transport', () => ({
	createSyncTransport: () => new MemoryTransport(),
}))

const { createApp } = await import('../../src/create-app')
type App = ReturnType<typeof createApp>

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { body: t.string() } },
		tags: { fields: { label: t.string() } },
	},
})

interface Notes {
	insert(data: { body: string }): Promise<{ id: string }>
	findById(id: string): Promise<{ body: string } | null>
}
const notes = (app: App): Notes => (app as unknown as { notes: Notes }).notes
const tags = (app: App): Notes => (app as unknown as { tags: Notes }).tags

let dir: string
const apps: App[] = []

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-d7-'))
	server = new KoraSyncServer({
		store: new MemoryServerStore('d7'),
		// Notes whose body says "forbidden" are refused; tags labelled "forbidden" too.
		validateOperation: (op: Operation) => {
			const value = op.data?.body ?? op.data?.label
			return value === 'forbidden'
				? { action: 'reject', code: 'WINDOW_CLOSED', message: 'Submissions are closed' }
				: { action: 'accept' }
		},
	})
})

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close()
	await server.stop()
	rmSync(dir, { recursive: true, force: true })
})

function device(name: string): App {
	const app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: join(dir, `${name}.db`) },
		sync: { url: 'ws://memory' },
	})
	apps.push(app)
	return app
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
	for (let i = 0; i < 250; i++) {
		if (await check()) return
		await new Promise((r) => setTimeout(r, 20))
	}
	throw new Error(`timed out waiting for ${what}`)
}

async function connected(app: App): Promise<void> {
	await app.ready
	await app.sync?.connect()
	await until(() => app.getSyncEngine()?.getState() === 'streaming', 'streaming')
}

function controllerFor<TArgs extends unknown[], TData>(
	app: App,
	fn: (...args: TArgs) => Promise<TData>,
): {
	controller: ReturnType<typeof createMutationController<TData, TArgs>>
	rejections: MutationRejection<TArgs>[]
} {
	const rejections: MutationRejection<TArgs>[] = []
	const controller = createMutationController<TData, TArgs>({
		mutationFn: fn,
		options: { onRejected: (r) => rejections.push(r) },
		events: app.events,
	})
	return { controller, rejections }
}

describe('useMutation rejection tracking (createApp, real engine and server)', () => {
	test('an immediate refusal is reported with its reason and the write is undone', async () => {
		const app = device('immediate')
		await connected(app)
		const { controller, rejections } = controllerFor(app, (body: string) =>
			notes(app).insert({ body }),
		)

		const row = await controller.mutateAsync('forbidden')
		await until(() => rejections.length > 0, 'the refusal')

		expect(rejections[0]).toMatchObject({
			code: 'WINDOW_CLOSED',
			message: 'Submissions are closed',
			collection: 'notes',
			recordId: row.id,
			reverted: true,
			args: ['forbidden'],
		})
		expect(rejections[0]?.operationIds).toHaveLength(1)
		expect(controller.getSnapshot().rejected).toEqual(rejections[0])
		await until(async () => (await notes(app).findById(row.id)) === null, 'the undo')
		controller.destroy()
	}, 20000)

	test('a write made offline is reported when it syncs later; accepted writes are not', async () => {
		const app = device('delayed')
		await app.ready
		const { controller, rejections } = controllerFor(app, (body: string) =>
			notes(app).insert({ body }),
		)

		await controller.mutateAsync('fine')
		const refused = await controller.mutateAsync('forbidden')
		await controller.mutateAsync('also fine')
		expect(rejections).toHaveLength(0)

		await connected(app)
		await until(() => rejections.length > 0, 'the late refusal')
		await until(
			async () => ((await app.sync?.getStatus())?.pendingOperations ?? 1) === 0,
			'all uploads resolved',
		)

		expect(rejections).toHaveLength(1)
		expect(rejections[0]).toMatchObject({ recordId: refused.id, args: ['forbidden'] })
		controller.destroy()
	}, 20000)

	test('a transaction is one write: the refusal reports every operation id of it', async () => {
		const app = device('transaction')
		await app.ready
		const { controller, rejections } = controllerFor(app, () =>
			app.transaction(async (tx) => {
				const proxy = tx as unknown as { notes: Notes; tags: Notes }
				await proxy.notes.insert({ body: 'fine' })
				await proxy.tags.insert({ label: 'forbidden' })
			}),
		)

		const operations = await controller.mutateAsync()
		await connected(app)
		await until(() => rejections.length > 0, 'the transaction refusal')

		expect(rejections).toHaveLength(1)
		expect(rejections[0]?.collection).toBe('tags')
		expect(rejections[0]?.operationIds).toEqual(operations.map((op) => op.id))
		controller.destroy()
	}, 20000)

	test('an unmounted (destroyed) controller reports nothing; the app event still fires', async () => {
		const app = device('unmounted')
		await app.ready
		const { controller, rejections } = controllerFor(app, (body: string) =>
			notes(app).insert({ body }),
		)
		const appLevel: string[] = []
		app.events.on('sync:operation-rejected', (event) => appLevel.push(event.code))

		await controller.mutateAsync('forbidden')
		controller.destroy()
		await connected(app)
		await until(() => appLevel.length > 0, 'the app-level event')

		expect(rejections).toHaveLength(0)
		expect(appLevel).toEqual(['WINDOW_CLOSED'])
		expect(await app.sync?.getRejectedOperations()).toHaveLength(1)
	}, 20000)

	test('a write through another path is not attributed to the controller', async () => {
		const app = device('other-writer')
		await connected(app)
		const { controller, rejections } = controllerFor(app, (body: string) =>
			notes(app).insert({ body }),
		)
		const appLevel: string[] = []
		app.events.on('sync:operation-rejected', (event) => appLevel.push(event.code))

		await tags(app).insert({ label: 'forbidden' })
		await until(() => appLevel.length > 0, 'the other refusal')

		expect(rejections).toHaveLength(0)
		controller.destroy()
	}, 20000)
})
