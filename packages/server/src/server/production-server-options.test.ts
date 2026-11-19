import { afterEach, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { type ProductionServer, createProductionServer } from './production-server'
import { InvalidServerConfigError } from './server-config-error'

/**
 * Size and count options are checked when the server is created: a value that is not a positive
 * whole number would turn a limit off (NaN never compares as reached) or refuse everything (0).
 */
let server: ProductionServer | null = null
afterEach(async () => {
	await server?.stop().catch(() => {})
	server = null
})

const create = (options: Record<string, unknown>): ProductionServer =>
	createProductionServer({ store: new MemoryServerStore('s'), ...options })

describe('createProductionServer checks its size and count options', () => {
	for (const option of ['maxConcurrentRequestBodies', 'maxRequestBodyBytes', 'maxBackupBytes']) {
		for (const value of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY, '10']) {
			test(`${option}: ${String(value)} is refused with a clear error`, () => {
				let thrown: unknown
				try {
					server = create({ [option]: value })
				} catch (error) {
					thrown = error
				}
				expect(thrown).toBeInstanceOf(InvalidServerConfigError)
				const error = thrown as InvalidServerConfigError
				expect(error.code).toBe('INVALID_SERVER_CONFIG')
				expect(error.context).toMatchObject({ option })
				expect(error.message).toContain(option)
			})
		}

		test(`${option}: 1 and the default are accepted`, async () => {
			server = create({ [option]: 1 })
			await server.stop()
			server = create({})
		})
	}
})
