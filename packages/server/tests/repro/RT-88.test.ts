/**
 * RT-88 (Phase 4 integration): the Postgres server store started initializing in its
 * constructor and nobody held the promise, so an unreachable database produced an
 * UNHANDLED rejection (which terminates Node by default) while
 * createPostgresServerStore() resolved as if the store were usable.
 *
 * Fixed behavior: createPostgresServerStore() rejects with a clear
 * SERVER_STORE_UNAVAILABLE error (the driver's error as cause), closes its client, and
 * no rejection is ever unhandled, also for a store constructed directly.
 *
 * Needs no Postgres: it points the driver at a closed local port.
 */
import { createServer } from 'node:net'
import { describe, expect, test } from 'vitest'
import { createPostgresServerStore } from '../../src/store/postgres-server-store'

async function closedPort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address ? address.port : 0
			server.close(() => resolve(port))
		})
	})
}

async function collectUnhandled<T>(fn: () => Promise<T>): Promise<{ unhandled: unknown[] }> {
	const unhandled: unknown[] = []
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)
	try {
		await fn()
		// Let any orphaned rejection surface.
		await new Promise((resolve) => setTimeout(resolve, 200))
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
	return { unhandled }
}

describe('RT-88: Postgres server store startup against an unreachable database', () => {
	test('createPostgresServerStore rejects clearly and leaves no unhandled rejection', async () => {
		const port = await closedPort()
		let failure: unknown = null
		const { unhandled } = await collectUnhandled(async () => {
			try {
				await createPostgresServerStore({
					connectionString: `postgres://kora:kora@127.0.0.1:${port}/kora?connect_timeout=2`,
				})
			} catch (error) {
				failure = error
			}
		})
		expect(unhandled).toEqual([])
		expect(failure).toMatchObject({ code: 'SERVER_STORE_UNAVAILABLE' })
		expect((failure as Error).message).toMatch(/PostgreSQL/)
		expect((failure as { cause?: unknown }).cause).toBeDefined()
	}, 20000)
})
