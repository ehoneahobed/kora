import postgres from 'postgres'

/**
 * Postgres schemas the tests of one file created (KORA_PG_TEST_URL). Their names carry
 * the worker's process id and a counter or random part, so they never repeat: a schema
 * left behind stays in the database for good, and repeated runs fill it.
 */
const created = new Set<string>()

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/

/**
 * Record a schema a test created, to drop with {@link dropTrackedPgSchemas}.
 *
 * @param name - The schema name, as created (unquoted, lower case)
 */
export function trackPgSchema(name: string): void {
	if (!SCHEMA_NAME.test(name)) {
		throw new Error(`Not a plain lower-case schema name: ${JSON.stringify(name)}`)
	}
	created.add(name)
}

/**
 * A schema name of this run only (`<prefix>_<pid>_<random>`), recorded for
 * {@link dropTrackedPgSchemas}. Never a fixed name: two runs on one database (two
 * checkouts, two agents, CI retries) would drop and recreate each other's tables
 * mid-test, and a fixed schema also keeps one run's leftovers for the next.
 *
 * @param prefix - A plain lower-case prefix naming the test file
 */
export function uniquePgSchemaName(prefix: string): string {
	const name = `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
	trackPgSchema(name)
	return name
}

/**
 * Drop every schema recorded with {@link trackPgSchema}, with everything in it. Register
 * it with `afterAll` before the hooks that end the file's Postgres clients: Vitest runs
 * `afterAll` hooks in reverse order of registration, so it runs after them. A schema that
 * cannot be dropped is reported, never fails the tests.
 */
/**
 * Run a statement again when Postgres picked it as the victim of a deadlock (`40P01`).
 *
 * A store's background work (the delivery-index backfill reads `operations` for a while after
 * `setSchema`) can still hold locks when a test drops its schema. The drop is cleanup, so
 * giving way and retrying is correct; the backfill is the one that stops.
 *
 * @param run - The statement to run
 * @param attempts - How many times to try before giving up
 */
export async function retryOnDeadlock<T>(run: () => Promise<T>, attempts = 6): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run()
		} catch (error) {
			const code = (error as { code?: unknown } | null)?.code
			if (code !== '40P01' || attempt >= attempts) throw error
			await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
		}
	}
}

export async function dropTrackedPgSchemas(): Promise<void> {
	const url = process.env.KORA_PG_TEST_URL
	const names = [...created]
	created.clear()
	if (!url || names.length === 0) return
	const admin = postgres(url, { max: 1, onnotice: () => {} })
	try {
		// A connection a test left in a transaction must not hang the run.
		await admin.unsafe(`SET lock_timeout = '10s'`)
		for (const name of names) {
			try {
				await retryOnDeadlock(() => admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`))
			} catch (error) {
				console.warn(`[kora test] could not drop Postgres test schema ${name}:`, error)
			}
		}
	} finally {
		await admin.end()
	}
}
