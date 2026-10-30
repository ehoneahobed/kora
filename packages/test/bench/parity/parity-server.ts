/**
 * The parity benchmark's server (design doc, section 2.1 and 11, S0): ONE `createProductionServer`
 * process and database serving both apps' static builds (brotli or gzip, `immutable` for hashed
 * assets), the Kora sync endpoint (`/kora-sync`), and the baseline's REST routes, which read and
 * write through `RouteContext` (`kora.query`, `kora.findById`, `kora.apply`) under the same
 * token grant the sync session gets. So both apps hit the same process, rows and grant.
 */
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib'
import {
	type AuthContext,
	type Logger,
	type MaterializedRecord,
	type ProductionHttpRoute,
	type ProductionHttpRouteRequest,
	type ProductionHttpRouteResponse,
	TokenAuthProvider,
	createProductionServer,
	createSqliteServerStore,
} from '@korajs/server'
import { digestRows } from '../browser/digest'
import type { CollectionDigest } from '../browser/digest'
import {
	type FixtureMeta,
	type FixtureShape,
	fixtureSchema,
	prepareFixtureDatabase,
} from '../browser/fixture-server'
import { LMS_COLLECTIONS } from '../lms-schema'

/** One navigation target: a course of the home list and its first lesson. */
export interface ParityTarget {
	courseId: string
	lessonId: string
}

export interface ParityServer {
	/** `http://127.0.0.1:<port>` */
	origin: string
	meta: FixtureMeta
	/** The home screen's rows as the baseline's `GET /api/courses` returns them, `[id, title]`. */
	homeRows(): Promise<Array<[string, string]>>
	/**
	 * Courses of the home list (in its order) that have at least one lesson, each with its first
	 * lesson by position: the screens the script opens (A in the first pass, B after, C warm).
	 */
	targets(count: number): Promise<ParityTarget[]>
	/** Digest of the school's rows per collection, now (after the devices' writes). */
	digests(): Promise<Record<string, CollectionDigest>>
	/**
	 * Grow the server's log by `count` server-authored updates of the school's records (the
	 * warm-stale cell): the first 25 retitle home courses so the home screen's rows change.
	 */
	grow(count: number): Promise<void>
	stop(): Promise<void>
}

/** Warnings and errors only. */
const quietLogger: Logger = {
	log(entry) {
		if (entry.level === 'warn' || entry.level === 'error') {
			console.error(`[parity server] ${entry.level} ${entry.event}`, entry.details ?? '')
		}
	},
}

function headerValue(request: ProductionHttpRouteRequest, name: string): string | undefined {
	const value = request.headers?.[name]
	return Array.isArray(value) ? value[0] : value
}

/** JSON with the compression a production API would use (brotli, else gzip). */
function compressedJson(
	request: ProductionHttpRouteRequest,
	status: number,
	body: unknown,
): ProductionHttpRouteResponse {
	const json = Buffer.from(JSON.stringify(body))
	const accept = headerValue(request, 'accept-encoding') ?? ''
	const headers: Record<string, string> = {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store, private',
		Vary: 'Accept-Encoding, Authorization',
	}
	if (/\bbr\b/.test(accept)) {
		headers['Content-Encoding'] = 'br'
		const raw = brotliCompressSync(json, {
			params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
		})
		return { status, raw: new Uint8Array(raw), headers }
	}
	if (/\bgzip\b/.test(accept)) {
		headers['Content-Encoding'] = 'gzip'
		return { status, raw: new Uint8Array(gzipSync(json, { level: 6 })), headers }
	}
	return { status, raw: new Uint8Array(json), headers }
}

/** The fields of a record the screens show (the delivery wire form keeps them all). */
function publicRecord(record: MaterializedRecord): Record<string, unknown> {
	const { id, title, position, parentId, ownerId, status, score, schoolId, body } = record
	return { id, title, position, parentId, ownerId, status, score, schoolId, body }
}

/**
 * Start the server on a free port, with a private copy of the shape's seeded database (seeded
 * and cached on first use, see `prepareFixtureDatabase`). `staticDir` holds `kora/` and
 * `baseline/`.
 */
export async function startParityServer(
	shape: FixtureShape,
	runDirectory: string,
	staticDir: string,
	log: (message: string) => void,
): Promise<ParityServer> {
	const { filename, meta } = await prepareFixtureDatabase(shape, runDirectory, log)
	const schema = fixtureSchema(shape)
	const store = createSqliteServerStore({ filename })
	await store.setSchema(schema)

	// One grant function for the sync handshake and the REST routes: the user is the token, and
	// every collection is scoped to the fixture's school.
	const grant = (token: string): AuthContext => ({
		userId: token,
		scopes: Object.fromEntries(LMS_COLLECTIONS.map((c) => [c, { schoolId: meta.school }])),
	})

	const api: ProductionHttpRoute = {
		path: '/api',
		async handle(request) {
			const authorization = headerValue(request, 'authorization') ?? ''
			const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
			if (token === '') return { status: 401, body: { error: 'unauthorized' } }
			const auth = grant(token)
			const scope = auth.scopes ?? {}
			const { kora } = request
			const parts = request.path.split('/').filter((part) => part !== '')
			// parts[0] is 'api'
			if (request.method === 'GET' && parts[1] === 'courses' && parts.length === 2) {
				const rows = await kora.query('courses', { orderBy: 'title', limit: 50, scope })
				return compressedJson(request, 200, rows.map(publicRecord))
			}
			if (request.method === 'GET' && parts[1] === 'courses' && parts[3] === 'lessons') {
				const courseId = decodeURIComponent(parts[2] ?? '')
				const rows = await kora.query('lessons', {
					where: { parentId: courseId },
					orderBy: 'position',
					scope,
				})
				return compressedJson(request, 200, rows.map(publicRecord))
			}
			if (request.method === 'GET' && parts[1] === 'lessons' && parts.length === 3) {
				const lessonId = decodeURIComponent(parts[2] ?? '')
				const [lesson, questions, progress] = await Promise.all([
					kora.findById('lessons', lessonId, { scope }),
					kora.query('questions', { where: { parentId: lessonId }, orderBy: 'position', scope }),
					kora.query('lesson_progress', {
						where: { parentId: lessonId, ownerId: auth.userId },
						orderBy: 'position',
						scope,
					}),
				])
				return compressedJson(request, 200, {
					lesson: lesson === null ? null : publicRecord(lesson),
					questions: questions.map(publicRecord),
					progress: progress.map(publicRecord),
				})
			}
			if (request.method === 'POST' && parts[1] === 'progress') {
				const body = request.body
				const lessonId =
					typeof body === 'object' && body !== null && 'lessonId' in body
						? String((body as { lessonId: unknown }).lessonId)
						: ''
				if (lessonId === '') return { status: 400, body: { error: 'lessonId required' } }
				const result = await kora.apply(
					{
						collection: 'lesson_progress',
						type: 'insert',
						data: {
							schoolId: meta.school,
							ownerId: auth.userId,
							parentId: lessonId,
							title: `Done by ${auth.userId}`,
							body: '',
							status: 'done',
							score: 100,
							position: 0,
						},
					},
					{ scope },
				)
				if (!result.ok)
					return { status: 409, body: { error: result.code, message: result.message } }
				if (result.record === null) return { status: 500, body: { error: 'no record' } }
				return compressedJson(request, 201, publicRecord(result.record))
			}
			return { status: 404, body: { error: 'not found' } }
		},
	}

	const server = createProductionServer({
		store,
		port: 0,
		staticDir,
		syncPath: '/kora-sync',
		httpRoutes: [api],
		syncOptions: {
			schemaVersion: schema.version,
			supportedSchemaVersions: { min: 1, max: 1 },
			batchSize: shape.batchSize,
			logger: quietLogger,
			relayRetransmitIntervalMs: 0,
			sessionRevalidationIntervalMs: 0,
			auth: new TokenAuthProvider({ validate: async (token) => grant(token) }),
		},
	})
	const url = await server.start()
	const port = new URL(url).port
	const scope = grant('harness').scopes ?? {}

	return {
		origin: `http://127.0.0.1:${port}`,
		meta,
		async homeRows() {
			const rows = await server.kora.query('courses', { orderBy: 'title', limit: 50, scope })
			return rows.map((row) => [row.id, String(row.title ?? '')])
		},
		async targets(count) {
			const found: ParityTarget[] = []
			const courses = await server.kora.query('courses', { orderBy: 'title', limit: 50, scope })
			for (const course of courses) {
				if (found.length >= count) break
				const lessons = await server.kora.query('lessons', {
					where: { parentId: course.id },
					orderBy: 'position',
					limit: 1,
					scope,
				})
				const lesson = lessons[0]
				if (lesson !== undefined) found.push({ courseId: course.id, lessonId: lesson.id })
			}
			if (found.length < count) {
				throw new Error(`only ${found.length} home courses have lessons; ${count} needed`)
			}
			return found
		},
		async digests() {
			const digests: Record<string, CollectionDigest> = {}
			for (const collection of LMS_COLLECTIONS) {
				const rows = await store.queryCollection(collection, { where: { schoolId: meta.school } })
				digests[collection] = digestRows(rows)
			}
			return digests
		},
		async grow(count) {
			// A deterministic walk over the school's records (a fixed-seed LCG), so every run
			// grows the same copy of the fixture the same way.
			let seed = 7
			const next = (): number => {
				seed = (seed * 1664525 + 1013904223) >>> 0
				return seed / 2 ** 32
			}
			const home = await server.kora.query('courses', { orderBy: 'title', limit: 50, scope })
			const pools: Array<{ collection: string; ids: string[] }> = []
			for (const collection of LMS_COLLECTIONS) {
				const rows = await store.queryCollection(collection, { where: { schoolId: meta.school } })
				if (rows.length > 0) pools.push({ collection, ids: rows.map((row) => row.id) })
			}
			for (let i = 0; i < count; i++) {
				const retitle = i < 25 ? home[i] : undefined
				const pool = pools[Math.floor(next() * pools.length)]
				if (pool === undefined) break
				const mutation =
					retitle !== undefined
						? {
								collection: 'courses',
								type: 'update' as const,
								recordId: retitle.id,
								data: { title: `Renamed ${i} ${String(retitle.title ?? '')}` },
							}
						: {
								collection: pool.collection,
								type: 'update' as const,
								recordId: pool.ids[Math.floor(next() * pool.ids.length)] as string,
								data: { score: Math.floor(next() * 100), status: next() < 0.5 ? 'active' : 'done' },
							}
				const result = await server.kora.apply(mutation, { scope })
				if (!result.ok) throw new Error(`grow: ${result.code} ${result.message}`)
			}
		},
		async stop() {
			await server.stop()
			await store.close()
		},
	}
}
