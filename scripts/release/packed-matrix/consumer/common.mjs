/**
 * Helpers for the matrix's consumer-side scripts. They run with plain `node` inside a fixture
 * project whose dependencies are the packed tarballs, so every import below resolves to what
 * `npm install korajs` would give a user.
 */

/** Thrown for a failed contract assertion; the message is what the matrix prints. */
export class ContractError extends Error {
	constructor(message) {
		super(message)
		this.name = 'ContractError'
	}
}

/** Fails with `label` unless `condition` holds. */
export function expect(condition, label, detail) {
	if (!condition) {
		throw new ContractError(detail === undefined ? label : `${label} (${JSON.stringify(detail)})`)
	}
}

/** Fails unless `actual` and `expected` are deeply equal (JSON form). */
export function expectEqual(actual, expected, label) {
	const a = JSON.stringify(actual)
	const b = JSON.stringify(expected)
	if (a !== b) throw new ContractError(`${label}: expected ${b}, got ${a}`)
}

/** Records one passed assertion on stdout so a failure shows how far the script got. */
export function pass(label) {
	process.stdout.write(`  ok  ${label}\n`)
}

/**
 * A free TCP port. Releases before beta.14 do not support `port: 0` in
 * `createProductionServer` (they report `http://localhost:0`), so a script that must also run
 * under a prior release picks the port itself.
 */
export async function freePort() {
	const { createServer } = await import('node:net')
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address !== null ? address.port : 0
			server.close(() => resolve(port))
		})
	})
}

/**
 * A WebSocket for a Node client: the global one on Node 22+, `ws` before that. The sync
 * transport reads `globalThis.WebSocket`.
 */
export async function ensureWebSocket() {
	if (typeof globalThis.WebSocket === 'function') return
	const { WebSocket } = await import('ws')
	globalThis.WebSocket = WebSocket
}

/**
 * Resolves when `subscribe`'s callback reports a value `predicate` accepts. Event-driven: the
 * only timer is the failure deadline, never a wait.
 *
 * @param {(callback: (value: any) => void) => () => void} subscribe
 * @param {(value: any) => boolean} predicate
 * @param {string} label
 * @param {number} [deadlineMs]
 */
export function until(subscribe, predicate, label, deadlineMs = 30_000) {
	return new Promise((resolve, reject) => {
		let unsubscribe = () => {}
		let done = false
		const finish = (action) => {
			if (done) return
			done = true
			clearTimeout(timer)
			unsubscribe()
			action()
		}
		const timer = setTimeout(
			() => finish(() => reject(new ContractError(`timed out waiting for ${label}`))),
			deadlineMs,
		)
		unsubscribe = subscribe((value) => {
			if (predicate(value)) finish(() => resolve(value))
		})
		if (done) unsubscribe()
	})
}

/** Resolves when the collection's query holds the titles `titles` (any order). */
export function untilTitles(collection, titles, label, deadlineMs) {
	const wanted = [...titles].sort()
	return until(
		(callback) => collection.where({}).subscribe(callback),
		(rows) => JSON.stringify(rows.map((row) => row.title).sort()) === JSON.stringify(wanted),
		label,
		deadlineMs,
	)
}

/** The titles currently held, sorted. */
export async function titlesOf(collection) {
	return (await collection.where({}).exec()).map((row) => row.title).sort()
}

/** Runs `main`, prints the failure and exits non-zero; exits zero when it returns. */
export async function runScript(name, main) {
	try {
		await main()
		process.stdout.write(`${name}: all contract assertions held\n`)
		process.exit(0)
	} catch (error) {
		process.stderr.write(
			`${name} FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		)
		process.exit(1)
	}
}
