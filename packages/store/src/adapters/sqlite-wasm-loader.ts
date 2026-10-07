import { WorkerInitError } from '../errors'

/** How long SQLite WASM may take to initialize before the open fails. */
export const SQLITE_INIT_TIMEOUT_MS = 60_000

/** Subscribes to unhandled promise rejections; returns the unsubscribe function. */
export type UnhandledRejectionSource = (listener: (reason: unknown) => void) => () => void

/** Options for {@link loadSqliteModule}. */
export interface LoadSqliteModuleOptions {
	/** Options passed to the module's init function (Emscripten module arguments). */
	initOptions?: Record<string, unknown>
	/** Where unhandled rejections are observed. Defaults to the global scope's event. */
	unhandledRejections?: UnhandledRejectionSource
	/** Init timeout in milliseconds. Defaults to {@link SQLITE_INIT_TIMEOUT_MS}. */
	timeoutMs?: number
}

/**
 * Initialize the SQLite WASM module, failing fast when the `.wasm` cannot be fetched
 * or compiled (F15).
 *
 * The sqlite-wasm build installs its own `instantiateWasm` hook, which fetches and
 * compiles the binary but drops the resulting promise: when the fetch fails (the
 * device is offline before the binary was ever cached) or the response is not WASM
 * (a 404 page), that rejection is unhandled and the module's init promise never
 * settles. Waiting for the init timeout then holds the app for a full minute. While
 * init runs, an unhandled fetch or WebAssembly error is therefore taken as the init's
 * failure and rejects at once.
 *
 * @param init - The module's init function (`@sqlite.org/sqlite-wasm`'s default export)
 * @param options - Init options, the rejection source (tests) and the timeout
 * @returns The initialized module
 * @throws {WorkerInitError} When the binary cannot be loaded, or init times out
 */
export async function loadSqliteModule<T>(
	init: (options?: Record<string, unknown>) => Promise<unknown>,
	options: LoadSqliteModuleOptions = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? SQLITE_INIT_TIMEOUT_MS
	const source = options.unhandledRejections ?? globalUnhandledRejections
	let timer: ReturnType<typeof setTimeout> | undefined
	let unsubscribe: (() => void) | undefined
	try {
		return (await Promise.race([
			init(options.initOptions),
			new Promise<never>((_, reject) => {
				unsubscribe = source((reason) => {
					if (!isWasmLoadFailure(reason)) return
					reject(
						new WorkerInitError(
							`could not load the SQLite WebAssembly binary (sqlite3.wasm): ${describe(reason)}. The device may be offline before the app was cached, or the file is not served (check the URL and the application/wasm MIME type).`,
							{ cause: describe(reason) },
						),
					)
				})
				timer = setTimeout(
					() =>
						reject(
							new WorkerInitError(`SQLite3 module init timed out after ${String(timeoutMs)}ms`),
						),
					timeoutMs,
				)
			}),
		])) as T
	} finally {
		if (timer !== undefined) clearTimeout(timer)
		unsubscribe?.()
	}
}

/**
 * True for the errors a failed `.wasm` fetch or compile produces: `TypeError` from
 * `fetch` or `instantiateStreaming` (network failure, wrong MIME type) and the
 * WebAssembly compile, link and runtime errors.
 */
function isWasmLoadFailure(reason: unknown): boolean {
	if (reason instanceof TypeError) return true
	const wasm = (globalThis as { WebAssembly?: Record<string, unknown> }).WebAssembly
	if (!wasm) return false
	for (const name of ['CompileError', 'LinkError', 'RuntimeError']) {
		const ctor = wasm[name]
		if (typeof ctor === 'function' && reason instanceof (ctor as new () => Error)) return true
	}
	return false
}

function describe(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason)
}

/** Unhandled rejections of the current global scope (a worker or a window). */
const globalUnhandledRejections: UnhandledRejectionSource = (listener) => {
	const scope = globalThis as {
		addEventListener?: (type: string, handler: (event: { reason?: unknown }) => void) => void
		removeEventListener?: (type: string, handler: (event: { reason?: unknown }) => void) => void
	}
	if (typeof scope.addEventListener !== 'function') return () => {}
	const handler = (event: { reason?: unknown }): void => listener(event.reason)
	scope.addEventListener('unhandledrejection', handler)
	return () => scope.removeEventListener?.('unhandledrejection', handler)
}
