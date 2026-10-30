/**
 * A real Kora sync server over WebSocket, loaded with the LMS-like first-sync fixture
 * (bench/lms-first-sync-fixture.ts), for the browser harness. The SQLite server store is
 * seeded once per fixture shape and cached on disk; every start copies the cached file so
 * devices never change the cache.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SchemaDefinition } from '@korajs/core'
import {
	KoraSyncServer,
	type Logger,
	TokenAuthProvider,
	createSqliteServerStore,
} from '@korajs/server'
import {
	HOME_COLLECTION,
	LMS_COLLECTIONS,
	generateLmsFixture,
	lmsFirstSyncSchema,
	lmsRelationsSchema,
} from '../lms-first-sync-fixture'
import { type CollectionDigest, digestRows } from './digest'

export interface FixtureShape {
	/** Operations of the device's own school. */
	visibleOps: number
	/** Schools sharing the log. */
	tenants: number
	/** Share of operations that insert (see `LmsFixtureOptions.insertRate`). Default 0.6. */
	insertRate: number
	/** Server delivery batch size. Default 100, the node benchmark's. */
	batchSize: number
	/** Generate with `relations: true` and serve `lmsRelationsSchema` (the parity benchmark). */
	relations?: boolean
}

/** The schema a shape's server and devices use. */
export function fixtureSchema(shape: FixtureShape): SchemaDefinition {
	return shape.relations === true ? lmsRelationsSchema : lmsFirstSyncSchema
}

/** What the page needs to know about the fixture, and what it must end up holding. */
export interface FixtureMeta {
	school: string
	homeCollection: string
	collections: string[]
	totalOps: number
	visibleOps: number
	/** Live records of the school over every collection. */
	liveRecords: number
	/** Visible operations per live record. */
	opsPerRecord: number
	homeRows: number
	/** The server's rows for the school, digested per collection. */
	digests: Record<string, CollectionDigest>
}

export interface FixtureServer {
	port: number
	meta: FixtureMeta
	stop(): Promise<void>
}

const CACHE_VERSION = 'v1'

/** Warnings and errors only: a per-batch info line would cost the server time and bury the output. */
const quietLogger: Logger = {
	log(entry) {
		if (entry.level === 'warn' || entry.level === 'error') {
			console.error(`[sync server] ${entry.level} ${entry.event}`, entry.details ?? '')
		}
	},
}

/** A free TCP port (the sync server does not report the port it bound). */
async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer()
		probe.once('error', reject)
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address()
			probe.close(() => {
				if (address !== null && typeof address === 'object') resolve(address.port)
				else reject(new Error('could not find a free port'))
			})
		})
	})
}

/** Where seeded databases are cached between runs (`KORA_BROWSER_BENCH_CACHE` overrides). */
export function cacheDirectory(): string {
	const dir =
		process.env.KORA_BROWSER_BENCH_CACHE ?? join(tmpdir(), 'kora-browser-first-sync-cache')
	mkdirSync(dir, { recursive: true })
	return dir
}

function shapeKey(shape: FixtureShape): string {
	const relations = shape.relations === true ? '-r' : ''
	return `${CACHE_VERSION}-v${shape.visibleOps}-t${shape.tenants}-i${shape.insertRate}${relations}`
}

/**
 * A private copy (in `runDirectory`) of the shape's seeded server database, and what the page
 * needs to know about it. Seeds and caches the database the first time a shape is requested
 * (about two minutes for 100,000 operations); later calls copy the cached file, so devices never
 * change the cache.
 */
export async function prepareFixtureDatabase(
	shape: FixtureShape,
	runDirectory: string,
	log: (message: string) => void,
): Promise<{ filename: string; meta: FixtureMeta }> {
	const cache = cacheDirectory()
	const key = shapeKey(shape)
	const cachedDb = join(cache, `${key}.db`)
	const cachedMeta = join(cache, `${key}.meta.json`)
	const filename = join(runDirectory, `server-${key}.db`)

	if (existsSync(cachedDb) && existsSync(cachedMeta)) {
		log(`fixture ${key}: using cached database`)
		copyFileSync(cachedDb, filename)
		return { filename, meta: JSON.parse(readFileSync(cachedMeta, 'utf8')) as FixtureMeta }
	}

	const seedFile = join(runDirectory, `seed-${key}.db`)
	const store = createSqliteServerStore({ filename: seedFile })
	await store.setSchema(fixtureSchema(shape))
	log(`fixture ${key}: generating`)
	const fixture = await generateLmsFixture({
		visibleOps: shape.visibleOps,
		tenants: shape.tenants,
		insertRate: shape.insertRate,
		moveRate: 0,
		relations: shape.relations === true,
	})
	log(`fixture ${key}: seeding ${fixture.operations.length} operations`)
	const started = performance.now()
	let done = 0
	for (const op of fixture.operations) {
		await store.applyRemoteOperation(op)
		done += 1
		if (done % 20_000 === 0) log(`  seeded ${done}/${fixture.operations.length}`)
	}
	log(`fixture ${key}: seeded in ${Math.round(performance.now() - started)} ms`)
	const digests: Record<string, CollectionDigest> = {}
	for (const collection of LMS_COLLECTIONS) {
		const rows = await store.queryCollection(collection, { where: { schoolId: fixture.school } })
		digests[collection] = digestRows(rows)
	}
	const liveRecords = Object.values(fixture.liveInScope).reduce((a, b) => a + b, 0)
	const meta: FixtureMeta = {
		school: fixture.school,
		homeCollection: HOME_COLLECTION,
		collections: [...LMS_COLLECTIONS],
		totalOps: fixture.operations.length,
		visibleOps: fixture.visibleOps,
		liveRecords,
		opsPerRecord: fixture.visibleOps / liveRecords,
		homeRows: fixture.homeRows,
		digests,
	}
	await store.close()
	copyFileSync(seedFile, cachedDb)
	writeFileSync(cachedMeta, JSON.stringify(meta))
	copyFileSync(cachedDb, filename)
	return { filename, meta }
}

/**
 * Start a sync server on a free port holding the fixture (see {@link prepareFixtureDatabase}).
 */
export async function startFixtureServer(
	shape: FixtureShape,
	runDirectory: string,
	log: (message: string) => void,
): Promise<FixtureServer> {
	const { filename, meta } = await prepareFixtureDatabase(shape, runDirectory, log)
	const store = createSqliteServerStore({ filename })
	await store.setSchema(fixtureSchema(shape))
	const fixtureMeta = meta
	const port = await freePort()
	const server = new KoraSyncServer({
		store,
		port,
		host: '127.0.0.1',
		schemaVersion: lmsFirstSyncSchema.version,
		supportedSchemaVersions: { min: 1, max: 1 },
		batchSize: shape.batchSize,
		logger: quietLogger,
		relayRetransmitIntervalMs: 0,
		sessionRevalidationIntervalMs: 0,
		auth: new TokenAuthProvider({
			validate: async (token) => ({
				userId: token,
				scopes: Object.fromEntries(
					LMS_COLLECTIONS.map((collection) => [collection, { schoolId: fixtureMeta.school }]),
				),
			}),
		}),
	})
	await server.start()
	return {
		port,
		meta: fixtureMeta,
		async stop() {
			await server.stop()
			await store.close()
		},
	}
}
