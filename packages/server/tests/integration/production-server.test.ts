import { type BlobRef, defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'

describe('createProductionServer operational auth', () => {
	test('keeps health public and protects operational endpoints when tokens are configured', async () => {
		const port = 39217
		const server = createProductionServer({
			store: new MemoryServerStore('server-1'),
			port,
			operationalAuth: {
				adminToken: 'admin-secret',
				metricsToken: 'metrics-secret',
				backupToken: 'backup-secret',
			},
		})

		await server.start()
		try {
			const baseUrl = `http://localhost:${port}`

			const health = await fetch(`${baseUrl}/health`)
			expect(health.status).toBe(200)

			const statusWithoutToken = await fetch(`${baseUrl}/__kora/status`)
			expect(statusWithoutToken.status).toBe(401)

			const statusWithToken = await fetch(`${baseUrl}/__kora/status`, {
				headers: { Authorization: 'Bearer admin-secret' },
			})
			expect(statusWithToken.status).toBe(200)

			const metricsWithAdminToken = await fetch(`${baseUrl}/__kora/metrics`, {
				headers: { Authorization: 'Bearer admin-secret' },
			})
			expect(metricsWithAdminToken.status).toBe(401)

			const metricsWithToken = await fetch(`${baseUrl}/__kora/metrics`, {
				headers: { Authorization: 'Bearer metrics-secret' },
			})
			expect(metricsWithToken.status).toBe(200)

			const backupWithToken = await fetch(`${baseUrl}/__kora/backup/export`, {
				method: 'POST',
				headers: { Authorization: 'Bearer backup-secret' },
			})
			expect(backupWithToken.status).toBe(200)
		} finally {
			await server.stop()
		}
	})

	test('uses credentialless COEP by default and allows explicit override', async () => {
		const defaultServer = createProductionServer({
			store: new MemoryServerStore('server-coep-default'),
			port: 39223,
		})
		await defaultServer.start()
		try {
			const response = await fetch('http://localhost:39223/health')
			expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('credentialless')
		} finally {
			await defaultServer.stop()
		}

		const strictServer = createProductionServer({
			store: new MemoryServerStore('server-coep-strict'),
			port: 39224,
			crossOriginEmbedderPolicy: 'require-corp',
		})
		await strictServer.start()
		try {
			const response = await fetch('http://localhost:39224/health')
			expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp')
		} finally {
			await strictServer.stop()
		}
	})

	test('mounts custom HTTP routes before static file serving', async () => {
		const port = 39218
		const server = createProductionServer({
			store: new MemoryServerStore('server-1'),
			port,
			httpRoutes: [
				{
					path: '/auth',
					async handle(request) {
						return {
							status: 200,
							body: {
								method: request.method,
								path: request.path,
								body: request.body,
								query: request.query,
								ip: request.ip,
							},
						}
					},
				},
			],
		})

		await server.start()
		try {
			const response = await fetch(`http://localhost:${port}/auth/signin?next=/dashboard`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'alice@example.com' }),
			})

			expect(response.status).toBe(200)
			const body = (await response.json()) as {
				method: string
				path: string
				body: { email: string }
				query: { next: string }
			}
			expect(body.method).toBe('POST')
			expect(body.path).toBe('/auth/signin')
			expect(body.body.email).toBe('alice@example.com')
			expect(body.query.next).toBe('/dashboard')

			const nonMatch = await fetch(`http://localhost:${port}/authentication/signin`)
			expect(nonMatch.status).toBe(404)
		} finally {
			await server.stop()
		}
	})

	// Regression: KoraForms hit a bug where a malformed request body reached
	// @korajs/auth's handleSignUp/handleSignIn as `undefined` fields, which
	// threw a TypeError inside a custom httpRoute handler. Because
	// http.createServer's request listener isn't awaited by Node, a handler
	// that throws becomes an unhandled promise rejection, which crashes the
	// entire process under Node's default `--unhandled-rejections=throw` —
	// one bad request took down the whole server, not just that response.
	// This proves the fix: any handler that throws returns a clean 500, and
	// the server keeps serving requests afterward instead of going down.
	test('a throwing httpRoutes handler returns 500 instead of crashing the server', async () => {
		const port = 39220
		const server = createProductionServer({
			store: new MemoryServerStore('server-1'),
			port,
			httpRoutes: [
				{
					path: '/echo',
					async handle(request) {
						// Simulates handleSignUp/handleSignIn crashing on a body field
						// that's missing at runtime despite its required `string` type.
						const email = (request.body as { email?: string } | undefined)?.email
						return { status: 200, body: { emailLength: (email as unknown as string).length } }
					},
				},
			],
		})

		await server.start()
		try {
			const baseUrl = `http://localhost:${port}`

			// No body at all — request.body is undefined, `.length` throws inside
			// the handler with the pre-fix code.
			const crashing = await fetch(`${baseUrl}/echo`, { method: 'POST' })
			expect(crashing.status).toBe(500)

			// The server must still be alive and serving normally afterward.
			const health = await fetch(`${baseUrl}/health`)
			expect(health.status).toBe(200)

			const stillWorks = await fetch(`${baseUrl}/echo`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'alice@example.com' }),
			})
			expect(stillWorks.status).toBe(200)
			const body = (await stillWorks.json()) as { emailLength: number }
			expect(body.emailLength).toBe('alice@example.com'.length)
		} finally {
			await server.stop()
		}
	})

	// Regression: the actual root cause of the KoraForms report. A raw
	// http.IncomingMessage starts paused; without an explicit resume() after
	// attaching 'data'/'end' listeners, the body reads back empty on some
	// Node versions/environments, so httpRoutes handlers (and @korajs/auth's
	// signup/signin built on top of them) silently never see the real body.
	test('reads the full POST body for httpRoutes handlers', async () => {
		const port = 39221
		const server = createProductionServer({
			store: new MemoryServerStore('server-1'),
			port,
			httpRoutes: [
				{
					path: '/echo',
					async handle(request) {
						return { status: 200, body: { received: request.body } }
					},
				},
			],
		})

		await server.start()
		try {
			const response = await fetch(`http://localhost:${port}/echo`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hello: 'world' }),
			})

			expect(response.status).toBe(200)
			const body = (await response.json()) as { received: { hello: string } }
			expect(body.received).toEqual({ hello: 'world' })
		} finally {
			await server.stop()
		}
	})
})

describe('createProductionServer data-plane surface', () => {
	const schema = defineSchema({
		version: 1,
		collections: {
			tasks: {
				fields: { title: t.string(), done: t.boolean().default(false) },
			},
			tags: {
				fields: { name: t.string() },
				constraints: [{ type: 'unique', fields: ['name'], onConflict: 'server-decides' }],
			},
			attachments: {
				fields: { label: t.string(), file: t.blob() },
			},
		},
	})

	test('server.kora applies and reads through the validated pipeline with no HTTP request', async () => {
		// A background job / scheduled task path: no request object, no client
		// connection, yet the same validated data plane as sync.
		const store = new MemoryServerStore('server-kora')
		await store.setSchema(schema)
		const server = createProductionServer({ store })

		const applied = await server.kora.apply({
			collection: 'tasks',
			type: 'insert',
			data: { title: 'seeded by a job', done: false },
		})
		expect(applied.ok).toBe(true)
		if (!applied.ok) return

		const readBack = await server.kora.findById('tasks', applied.operation.recordId)
		expect(readBack?.title).toBe('seeded by a job')

		const all = await server.kora.query('tasks')
		expect(all).toHaveLength(1)
	})

	test('server.kora surfaces a non-retriable rejection when a constraint is violated', async () => {
		const store = new MemoryServerStore('server-kora-reject')
		await store.setSchema(schema)
		const server = createProductionServer({ store })

		const first = await server.kora.apply({
			collection: 'tags',
			type: 'insert',
			recordId: 'tag-1',
			data: { name: 'urgent' },
		})
		expect(first.ok).toBe(true)

		// A second record with the same unique name must be refused, and the
		// refusal must be classed permanent — resubmitting the same bytes can never
		// succeed, so a client should not retry it.
		const second = await server.kora.apply({
			collection: 'tags',
			type: 'insert',
			recordId: 'tag-2',
			data: { name: 'urgent' },
		})
		expect(second.ok).toBe(false)
		if (second.ok) return
		expect(second.retriable).toBe(false)
	})

	test('getLiveBlobRefs returns every blob still reachable from a live record', async () => {
		const store = new MemoryServerStore('server-blobs')
		await store.setSchema(schema)
		const server = createProductionServer({ store })

		const ref: BlobRef = {
			hash: 'a'.repeat(64),
			size: 3,
			mimeType: 'text/plain',
			filename: 'note.txt',
		}
		const inserted = await server.kora.apply({
			collection: 'attachments',
			type: 'insert',
			data: { label: 'a note', file: ref },
		})
		expect(inserted.ok).toBe(true)
		if (!inserted.ok) return

		const live = await server.getLiveBlobRefs()
		expect(live.map((r) => r.hash)).toContain(ref.hash)

		// After the record is deleted, the blob is no longer live, so a scheduled
		// GC using this set would reclaim it.
		await server.kora.apply({
			collection: 'attachments',
			type: 'delete',
			recordId: inserted.operation.recordId,
		})
		const afterDelete = await server.getLiveBlobRefs()
		expect(afterDelete.map((r) => r.hash)).not.toContain(ref.hash)
	})

	test('accepts maxOperationBytes and maxOpsPerMinute at server config', async () => {
		// The knobs are set once at the server level (item 3). Enforcement itself
		// is covered against a live session in kora-sync-server.test.ts.
		const store = new MemoryServerStore('server-limits')
		await store.setSchema(schema)
		const server = createProductionServer({
			store,
			syncOptions: { maxOperationBytes: 1024, maxOpsPerMinute: 5 },
		})
		const applied = await server.kora.apply({
			collection: 'tasks',
			type: 'insert',
			data: { title: 'ok', done: false },
		})
		expect(applied.ok).toBe(true)
	})
})
