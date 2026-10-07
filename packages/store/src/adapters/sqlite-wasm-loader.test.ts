import { describe, expect, test, vi } from 'vitest'
import { WorkerInitError } from '../errors'
import { type UnhandledRejectionSource, loadSqliteModule } from './sqlite-wasm-loader'

/** A rejection source the test fires by hand, and a count of live subscriptions. */
function rejectionSource(): {
	source: UnhandledRejectionSource
	fire: (reason: unknown) => void
	live: () => number
} {
	const listeners = new Set<(reason: unknown) => void>()
	return {
		source: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		fire: (reason) => {
			for (const listener of listeners) listener(reason)
		},
		live: () => listeners.size,
	}
}

/** An init that, like sqlite-wasm's own instantiateWasm hook, never settles. */
const hangingInit = (): Promise<unknown> => new Promise(() => {})

describe('loadSqliteModule (F15)', () => {
	test('a failed .wasm fetch rejects at once instead of after the init timeout', async () => {
		vi.useFakeTimers()
		try {
			const rejections = rejectionSource()
			const loading = loadSqliteModule(hangingInit, {
				unhandledRejections: rejections.source,
			})
			const outcome = loading.then(
				() => 'resolved',
				(error: unknown) => error,
			)
			// The sqlite-wasm hook's fetch fails while nobody handles its promise.
			rejections.fire(new TypeError('Failed to fetch'))
			const error = await outcome
			expect(error).toBeInstanceOf(WorkerInitError)
			expect((error as Error).message).toMatch(/sqlite3\.wasm.*Failed to fetch/)
			expect(rejections.live()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	test('a response that is not WebAssembly rejects too', async () => {
		const rejections = rejectionSource()
		const loading = loadSqliteModule(hangingInit, { unhandledRejections: rejections.source })
		rejections.fire(new WebAssembly.CompileError('expected magic word'))
		await expect(loading).rejects.toThrow(/expected magic word/)
	})

	test('unrelated unhandled rejections do not fail the init', async () => {
		const rejections = rejectionSource()
		let resolve: (value: unknown) => void = () => {}
		const loading = loadSqliteModule<{ ok: true }>(
			() =>
				new Promise((r) => {
					resolve = r
				}),
			{ unhandledRejections: rejections.source },
		)
		rejections.fire(new Error('some app error'))
		resolve({ ok: true })
		await expect(loading).resolves.toEqual({ ok: true })
		expect(rejections.live()).toBe(0)
	})

	test('still times out when nothing reports a failure', async () => {
		vi.useFakeTimers()
		try {
			const loading = loadSqliteModule(hangingInit, {
				unhandledRejections: rejectionSource().source,
				timeoutMs: 1_000,
			})
			const outcome = loading.catch((error: unknown) => error)
			await vi.advanceTimersByTimeAsync(1_000)
			expect(await outcome).toBeInstanceOf(WorkerInitError)
		} finally {
			vi.useRealTimers()
		}
	})

	test('passes the init options through', async () => {
		const init = vi.fn(async () => 'module')
		await loadSqliteModule(init, {
			initOptions: { locateFile: 'x' },
			unhandledRejections: rejectionSource().source,
		})
		expect(init).toHaveBeenCalledWith({ locateFile: 'x' })
	})
})
