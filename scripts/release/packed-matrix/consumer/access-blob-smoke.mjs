/**
 * Packed access rules and blobs, end to end with real accounts: the production server with
 * `@korajs/auth` sign-up, a schema with `access` rules and a blob field, central blob storage,
 * and Node clients that sign in as two users.
 *
 * Contract:
 *   1. A user reads only the documents they own or are a member of; a non-member's device
 *      never receives the record.
 *   2. `server.access.grant` delivers the document live; a `view` member's write is refused
 *      (`ACCESS_DENIED`) and changes nothing; an `edit` member's write reaches the owner.
 *   3. A blob attached to the document reaches a member (bytes verified), and a non-member is
 *      refused the bytes.
 *   4. `server.access.revoke` retracts the document from the removed member's device.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import { createKoraAuthServer, createSqliteUserStore } from '@korajs/auth/server'
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import { toServerBlobCallbacks } from '@korajs/store'
import { FilesystemBlobStore } from '@korajs/store/blob-fs'
import { createApp, defineSchema, member, memberOfKey, owner, t } from 'korajs'
import { ensureWebSocket, expect, expectEqual, pass, runScript, until } from './common.mjs'

const DIR = process.env.KORA_ACCESS_DIR
const SECRET = 'matrix-secret-that-is-long-enough-0123456789'
const PASSWORD = 'correct-horse-battery-staple-9'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group') },
		},
		documents: {
			fields: {
				title: t.string(),
				ownerId: t.string().stamp('userId'),
				attachment: t.blob().optional(),
			},
			access: {
				read: member('id'),
				create: owner('ownerId'),
				update: member('id', 'edit'),
				delete: member('id', 'manage'),
			},
		},
	},
})

const titles = async (app) => (await app.documents.where({}).exec()).map((row) => row.title).sort()

await runScript('access-blob-smoke', async () => {
	expect(DIR, 'KORA_ACCESS_DIR is set')
	await ensureWebSocket()
	mkdirSync(DIR, { recursive: true })

	const store = await createSqliteServerStore({ filename: join(DIR, 'server.db') })
	await store.setSchema(schema)
	const auth = await createKoraAuthServer({
		jwtSecret: SECRET,
		userStore: await createSqliteUserStore({ filename: join(DIR, 'auth.db') }),
	})
	const blobStore = new FilesystemBlobStore(join(DIR, 'blobs'))
	const server = createProductionServer({
		store,
		port: 0,
		staticDir: DIR,
		httpRoutes: [{ path: '/auth', handle: auth.handleRequest }],
		syncOptions: {
			schemaVersion: schema.version,
			logger: { log() {} },
			auth: auth.auth,
			...toServerBlobCallbacks(blobStore),
		},
	})
	const apps = []
	try {
		const url = await server.start()
		const device = async (name) => {
			const client = createKoraAuth({ serverUrl: url })
			const user = await client.signUp({
				email: `${name}-${process.pid}@example.test`,
				password: PASSWORD,
			})
			const app = createApp({
				schema,
				store: { adapter: 'better-sqlite3', name: join(DIR, `${name}.db`) },
				sync: {
					url: `${url.replace('http', 'ws')}/kora-sync`,
					authClient: createKoraAuthSync({ authClient: client, schema }),
					autoConnect: false,
				},
			})
			apps.push(app)
			await app.ready
			await app.sync.connect()
			await app.sync.waitForSettled()
			return { app, userId: user.id }
		}
		const alice = await device('alice')
		const bob = await device('bob')
		const carol = await device('carol')

		// 1. Reads follow ownership and membership.
		const doc = await alice.app.documents.insert({ title: 'Quarterly plan' })
		const bytes = new TextEncoder().encode('confidential attachment bytes')
		const { ref } = await alice.app.blobs.put(bytes, {
			filename: 'plan.txt',
			mimeType: 'text/plain',
		})
		await alice.app.documents.update(doc.id, { attachment: ref })
		await alice.app.sync.waitForSettled()
		for (const other of [bob, carol]) {
			await other.app.sync.waitForSettled()
			expectEqual(await titles(other.app), [], 'a non-member receives no document')
		}
		pass('a document reaches nobody but its owner')

		// 2. Grant, refused write, permitted write.
		await server.access.grant({ userId: bob.userId, group: ['documents', doc.id], role: 'view' })
		await until(
			(callback) => bob.app.documents.where({}).subscribe(callback),
			(rows) => rows.some((row) => row.title === 'Quarterly plan'),
			'the view member to receive the document live',
		)
		expectEqual(await titles(carol.app), [], 'a different non-member still receives nothing')
		const rejection = until(
			(callback) => bob.app.events.on('sync:operation-rejected', callback),
			(event) => event.collection === 'documents',
			'the server to refuse the view member write',
		)
		await bob.app.documents.update(doc.id, { title: 'bob was here' })
		const refusal = await rejection
		expectEqual(refusal.code, 'ACCESS_DENIED', 'the refusal code of a view member write')
		await alice.app.sync.waitForSettled()
		expectEqual(
			await titles(alice.app),
			['Quarterly plan'],
			'the refused write changed nothing for the owner',
		)
		pass('a view member receives the document; their write is refused and changes nothing')

		await server.access.grant({ userId: bob.userId, group: ['documents', doc.id], role: 'edit' })
		await bob.app.sync.waitForSettled()
		await bob.app.documents.update(doc.id, { title: 'Quarterly plan v2' })
		await until(
			(callback) => alice.app.documents.where({}).subscribe(callback),
			(rows) => rows.some((row) => row.title === 'Quarterly plan v2'),
			'the edit by the edit member to reach the owner',
		)
		pass('an edit member write reaches the owner')

		// 3. Blob bytes follow the same access.
		const received = await bob.app.blobs.pull(ref)
		expect(received !== null, 'a member pulls the blob')
		expectEqual(
			new TextDecoder().decode((await bob.app.blobs.get(ref.hash)) ?? new Uint8Array()),
			'confidential attachment bytes',
			'the member holds the exact blob bytes',
		)
		let refused = false
		try {
			await carol.app.blobs.pull(ref)
			refused = (await carol.app.blobs.get(ref.hash)) === null
		} catch {
			refused = true
		}
		expect(refused, 'a non-member is refused the blob bytes')
		pass('blob bytes reach a member and are refused to a non-member')

		// 4. Revocation retracts.
		await server.access.revoke({ userId: bob.userId, group: ['documents', doc.id] })
		await until(
			(callback) => bob.app.documents.where({}).subscribe(callback),
			(rows) => rows.length === 0,
			'the document to leave the revoked member device',
		)
		pass('revoking a membership removes the document from the member device')
	} finally {
		for (const app of apps) await app.close().catch(() => {})
		await server.stop().catch(() => {})
		await store.close().catch(() => {})
	}
})
