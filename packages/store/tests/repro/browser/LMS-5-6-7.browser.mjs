/**
 * Real-browser reproductions for LMS report items #5, #6, #7 (@korajs/store, OPFS SAH pool + multi-tab).
 *
 * Asserts CORRECT behaviour; checks marked FAIL demonstrate the defect on 1.0.0-beta.12.
 * Uses the BUILT dist of @korajs/store and @korajs/core plus @sqlite.org/sqlite-wasm, bundled
 * with esbuild and served with COOP/COEP by lms-harness/build-and-serve.mjs. No mocks: real
 * Chromium, real OPFS, real navigator.locks/BroadcastChannel.
 *
 * Run (from repo root, after `pnpm --filter @korajs/core --filter @korajs/store build`):
 *   PW_CHROMIUM_PATH=/opt/pw-browsers/chromium node packages/store/tests/repro/browser/LMS-5-6-7.browser.mjs [filter]
 * Exit code 1 if any check fails.
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { buildAndServe } from './lms-harness/build-and-serve.mjs'

const require = createRequire(new URL('../../../../../e2e/package.json', import.meta.url))
const { chromium } = require('@playwright/test')
const filter = process.argv[2] ?? ''
const results = []
const check = (id, name, pass, detail) => {
	results.push({ id, name, pass, detail })
	console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${name}${detail ? `\n       ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { server, url } = await buildAndServe(path.join(os.tmpdir(), `kora-lms-repro-${process.pid}`))
const browser = await chromium.launch({
	executablePath: process.env.PW_CHROMIUM_PATH || undefined,
	args: [
		'--disable-background-timer-throttling',
		'--disable-renderer-backgrounding',
		'--disable-backgrounding-occluded-windows',
	],
})
async function tab(ctx) {
	const p = await ctx.newPage()
	await p.goto(url)
	await p.waitForFunction(() => window.__ready === true)
	return p
}
const J = (v) => JSON.stringify(v)

const scenarios = {
	// ---------------------------------------------------------------- #5
	async 'LMS-5a'() {
		// Raw VFS fact: a second installOpfsSAHPoolVfs of the same pool name fails immediately.
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		await A.evaluate(() => H.newRaw('w'))
		const a = await A.evaluate(() => H.rawCall('w', 'install', { name: 'kora-opfs' }))
		await B.evaluate(() => H.newRaw('w'))
		const b = await B.evaluate(() => H.rawCall('w', 'install', { name: 'kora-opfs' }))
		console.log(`       first install: ${J(a.data)}; second: ${J(b.error)}`)
		check(
			'LMS-5a',
			'fact: default pool capacity is 6',
			a.data?.capacity === 6,
			`capacity=${a.data?.capacity}`,
		)
		check(
			'LMS-5a',
			'fact: 2nd context installing same pool gets NoModificationAllowedError',
			!b.ok && b.error?.name === 'NoModificationAllowedError',
			J(b.error),
		)
		// How long until a retry succeeds after the holder goes away?
		await A.evaluate(() => H.killRaw('w'))
		const t0 = Date.now()
		let tries = 0
		let okAt = -1
		while (Date.now() - t0 < 5000) {
			tries++
			await B.evaluate(() => {
				H.killRaw('w')
				return H.newRaw('w')
			})
			const r = await B.evaluate(() => H.rawCall('w', 'install', { name: 'kora-opfs' }))
			if (r.ok) {
				okAt = Date.now() - t0
				break
			}
			await sleep(20)
		}
		check(
			'LMS-5a',
			'fact: once the holder worker is terminated, a re-install succeeds quickly',
			okAt >= 0,
			`succeeded after ${okAt}ms / ${tries} tries`,
		)
		await ctx.close()
	},
	async 'LMS-5b'() {
		// Kora: two DIFFERENT dbNames on one origin (namespaceByAuthUser users, or two Kora apps)
		// in two tabs. Leader election is per dbName, but the SAH pool name 'kora-opfs' is
		// origin-global, so both tabs become leaders and both try to own the pool.
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		const a = await A.evaluate(() => H.open('a', 'school__user_alice'))
		const b = await B.evaluate(() => H.open('b', 'school__user_bob'))
		console.log(`       alice: ${J(a)}\n       bob:   ${J(b)}`)
		check(
			'LMS-5b',
			'second tab (different dbName) gets durable storage',
			b.ok && b.state?.persistent === true,
			`bob state=${J(b.state)} role=${b.role}`,
		)
		const ev = await B.evaluate(() => H.events.map((e) => e.type))
		console.log(`       bob events: ${J(ev)}`)
		await B.evaluate(() => H.insert('b', 'bob-unsynced-write'))
		await B.evaluate(() => H.close('b'))
		await A.evaluate(() => H.close('a'))
		await sleep(300)
		const C = await tab(ctx)
		const c = await C.evaluate(() => H.open('c', 'school__user_bob'))
		const t = await C.evaluate(() => H.titles('c'))
		check(
			'LMS-5b',
			"bob's write from that session survives reload",
			t.ok && t.titles.includes('bob-unsynced-write'),
			`reopen state=${J(c.state)} titles=${J(t.titles)}`,
		)
		await ctx.close()
	},
	async 'LMS-5c'() {
		// What createApp() actually does on OPFS failure: falls back to IndexedDbAdapter.
		// Show the IDB dataset is disjoint from the OPFS dataset (split brain across sessions).
		const ctx = await browser.newContext()
		const S1 = await tab(ctx)
		await S1.evaluate(() => H.open('s', 'shared_device'))
		await S1.evaluate(() => H.insert('s', 'opfs-row-session-1'))
		await S1.evaluate(() => H.close('s'))
		await sleep(300)
		// Session 2: OPFS pool held by another Kora app on the origin -> createApp would pick IndexedDB.
		const Other = await tab(ctx)
		await Other.evaluate(() => H.open('o', 'other_app'))
		const S2 = await tab(ctx)
		const s2 = await S2.evaluate(() => H.open('s', 'shared_device', { indexeddb: true }))
		const s2t = await S2.evaluate(() => H.titles('s'))
		console.log(`       session-2 (IDB fallback) open=${J(s2)} titles=${J(s2t.titles)}`)
		check(
			'LMS-5c',
			'fallback session sees data written in earlier OPFS session',
			s2t.ok && s2t.titles.includes('opfs-row-session-1'),
			`titles=${J(s2t.titles)}`,
		)
		await S2.evaluate(() => H.insert('s', 'idb-row-session-2'))
		await S2.evaluate(() => H.close('s'))
		await Other.evaluate(() => H.close('o'))
		await sleep(300)
		// Session 3: OPFS available again -> createApp picks sqlite-wasm/OPFS.
		const S3 = await tab(ctx)
		const s3 = await S3.evaluate(() => H.open('s', 'shared_device'))
		const s3t = await S3.evaluate(() => H.titles('s'))
		check(
			'LMS-5c',
			'next OPFS session sees writes made during fallback session',
			s3t.ok && s3t.titles.includes('idb-row-session-2'),
			`state=${J(s3.state)} titles=${J(s3t.titles)}`,
		)
		await ctx.close()
	},
	async 'LMS-5d'() {
		// Same dbName, leader hands off via adapter.close() (logout / auth switch / HMR):
		// close() releases the leader lock BEFORE terminating the worker that holds the pool.
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		await A.evaluate(() => H.open('x', 'handoff'))
		const b = await B.evaluate(() => H.open('x', 'handoff'))
		check(
			'LMS-5d',
			'fact: same-dbName second tab is a follower (does not install the pool)',
			b.role === 'follower',
			`role=${b.role}`,
		)
		await A.evaluate(() => H.insert('x', 'before-handoff'))
		await A.evaluate(() => H.close('x'))
		await sleep(1500)
		const role = await B.evaluate(() => H.role('x'))
		const w = await B.evaluate(() => H.insert('x', 'after-handoff'))
		const tb = await B.evaluate(() => H.titles('x'))
		const ev = await B.evaluate(() => H.events.map((e) => e.type))
		console.log(`       B role=${role} insert=${J(w)} titles=${J(tb.titles)} events=${J(ev)}`)
		check(
			'LMS-5d',
			'promoted follower still sees pre-handoff data',
			tb.ok && tb.titles?.includes('before-handoff'),
			`titles=${J(tb.titles)}`,
		)
		await B.evaluate(() => H.close('x'))
		await sleep(300)
		const C = await tab(ctx)
		await C.evaluate(() => H.open('x', 'handoff'))
		const tc = await C.evaluate(() => H.titles('x'))
		check(
			'LMS-5d',
			'write made by promoted follower is durable',
			tc.ok && tc.titles.includes('after-handoff'),
			`titles after reopen=${J(tc.titles)}`,
		)
		await ctx.close()
	},
	async 'LMS-5e'() {
		// Same as 5d but the leader TAB is closed (crash / user closes tab).
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		await A.evaluate(() => H.open('x', 'tabclose'))
		await B.evaluate(() => H.open('x', 'tabclose'))
		await A.evaluate(() => H.insert('x', 'before-close'))
		await A.close({ runBeforeUnload: false })
		await sleep(1500)
		const role = await B.evaluate(() => H.role('x'))
		const w = await B.evaluate(() => H.insert('x', 'after-close'))
		const tb = await B.evaluate(() => H.titles('x'))
		console.log(`       B role=${role} insert=${J(w)} titles=${J(tb.titles)}`)
		await B.evaluate(() => H.close('x'))
		await sleep(300)
		const C = await tab(ctx)
		await C.evaluate(() => H.open('x', 'tabclose'))
		const tc = await C.evaluate(() => H.titles('x'))
		check(
			'LMS-5e',
			'after leader tab closes, promoted follower writes are durable',
			tc.ok && tc.titles.includes('after-close') && tc.titles.includes('before-close'),
			`titles=${J(tc.titles)}`,
		)
		await ctx.close()
	},
	async 'LMS-5f'() {
		// Promotion path when the pool is not obtainable at promotion time (another Kora
		// database/app on the origin grabbed it first). promoteToLeader() re-opens without
		// checking `persistent`, so the promoted tab silently runs in memory.
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		const D = await tab(ctx)
		await A.evaluate(() => H.open('x', 'promo5f'))
		await B.evaluate(() => H.open('x', 'promo5f'))
		await A.evaluate(() => H.insert('x', 'before-promotion'))
		await D.evaluate(() => H.newRaw('w'))
		// D spins trying to install the pool (stand-in for another dbName's leader opening).
		await D.evaluate(() => {
			window.__spin = (async () => {
				for (let i = 0; i < 400; i++) {
					const r = await H.rawCall('w', 'install', {
						name: 'kora-opfs',
						opts: { forceReinitIfPreviouslyFailed: true },
					})
					if (r.ok) return i
					H.killRaw('w')
					await H.newRaw('w')
				}
				return -1
			})()
			return true
		})
		await A.evaluate(() => H.close('x'))
		const got = await D.evaluate(() => window.__spin)
		await sleep(1500)
		const w = await B.evaluate(() => H.insert('x', 'after-promotion'))
		const tb = await B.evaluate(() => H.titles('x'))
		const ev = await B.evaluate(() => H.events.map((e) => e.type))
		console.log(
			`       D got pool after ${got} tries; B role=${await B.evaluate(() => H.role('x'))} write=${J(w)} titles=${J(tb.titles)} events=${J(ev)}`,
		)
		check(
			'LMS-5f',
			'promoted follower either has durable storage or surfaces a blocking error/event',
			(tb.ok && tb.titles.includes('before-promotion')) ||
				ev.includes('store:opfs-unavailable') ||
				!w.ok,
			`titles=${J(tb.titles)} events=${J(ev)}`,
		)
		await B.evaluate(() => H.close('x'))
		await D.evaluate(() => H.killRaw('w'))
		await sleep(300)
		const C = await tab(ctx)
		await C.evaluate(() => H.open('x', 'promo5f'))
		const tc = await C.evaluate(() => H.titles('x'))
		check(
			'LMS-5f',
			'write accepted by promoted follower is durable',
			tc.ok && tc.titles.includes('after-promotion'),
			`titles after reopen=${J(tc.titles)}`,
		)
		await ctx.close()
	},
	async 'LMS-5g'() {
		// Single tab reload x10: does the new document ever race the old document's worker for the pool?
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const states = []
		for (let i = 0; i < 10; i++) {
			const o = await A.evaluate(() => H.open('x', 'reload5g'))
			states.push(o.state?.mode ?? o.error)
			await A.evaluate((i) => H.insert('x', `r${i}`), i)
			await A.reload()
			await A.waitForFunction(() => window.__ready === true)
		}
		console.log(`       modes across reloads: ${J(states)}`)
		check(
			'LMS-5g',
			'every reload re-opens durable OPFS storage',
			states.every((m) => m === 'opfs'),
			J(states),
		)
		await ctx.close()
	},
	async 'LMS-5h'() {
		// Evaluate the LMS retry patch: it re-calls installOpfsSAHPoolVfs in the SAME worker
		// without forceReinitIfPreviouslyFailed. sqlite-wasm caches the rejected init promise.
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		await A.evaluate(() => H.newRaw('w'))
		await A.evaluate(() => H.rawCall('w', 'install', { name: 'kora-opfs' }))
		await B.evaluate(() => H.newRaw('w'))
		const b1 = await B.evaluate(() => H.rawCall('w', 'install', { name: 'kora-opfs' }))
		await A.evaluate(() => H.killRaw('w'))
		await sleep(2000) // the patch's retry delay; holder is long gone
		const b2 = await B.evaluate(() =>
			H.rawCall('w', 'install', { name: 'kora-opfs', opts: { initialCapacity: 32 } }),
		)
		console.log(
			`       first: ${b1.error?.name}; retry after holder released (LMS patch args): ${J(b2.ok ? b2.data : b2.error)}`,
		)
		check(
			'LMS-5h',
			'LMS retry (same worker, no forceReinitIfPreviouslyFailed) succeeds once holder is gone',
			b2.ok,
			J(b2.error),
		)
		const b3 = await B.evaluate(() =>
			H.rawCall('w', 'install', {
				name: 'kora-opfs',
				opts: { forceReinitIfPreviouslyFailed: true },
			}),
		)
		check(
			'LMS-5h',
			'fact: retry with forceReinitIfPreviouslyFailed:true succeeds',
			b3.ok,
			J(b3.error ?? b3.data),
		)
		await ctx.close()
	},
	// ---------------------------------------------------------------- #6
	async 'LMS-6a'() {
		// Kora's own per-user databases (store.namespaceByAuthUser) accumulate in the one pool.
		const ctx = await browser.newContext()
		const P = await tab(ctx)
		const log = []
		let firstFail = null
		for (let i = 1; i <= 8; i++) {
			const name = `lms__user_u${i}`
			await sleep(200) // isolate capacity from the close->reopen race shown in 5d
			const o = await P.evaluate((n) => H.open('u', n), name)
			const w = o.ok
				? await P.evaluate((n) => H.insert('u', n), name)
				: { ok: false, error: 'not opened' }
			log.push({ i, open: o.ok ? o.state : o.error, insert: w.ok ? 'ok' : w.error })
			if ((!o.ok || !w.ok || o.state?.persistent !== true) && firstFail === null) firstFail = i
			await P.evaluate(() => H.close('u')) // close even after a failed open, to isolate capacity from the leak in 6c
		}
		for (const l of log) console.log(`       user${l.i}: open=${J(l.open)} insert=${l.insert}`)
		check(
			'LMS-6a',
			'8 per-user Kora databases on one origin all open durably and accept writes',
			firstFail === null,
			`first failure at user #${firstFail}`,
		)
		// Collateral: once the pool is full, can an EXISTING user's DB still commit a write?
		await sleep(300)
		const Q = await tab(ctx)
		const o1 = await Q.evaluate(() => H.open('u', 'lms__user_u1'))
		const w1 = o1.ok
			? await Q.evaluate(() => H.insert('u', 'u1-later-write'))
			: { ok: false, error: o1.error }
		check(
			'LMS-6a',
			'existing user #1 can still write after pool filled by other users',
			w1.ok,
			`open=${J(o1.state ?? o1.error)} write=${J(w1)}`,
		)
		await ctx.close()
	},
	async 'LMS-6c'() {
		// A failed SqliteWasmAdapter.open() (pool full) does not release its worker / leader lock,
		// so the SAH pool stays held for the page lifetime.
		const ctx = await browser.newContext()
		const P = await tab(ctx)
		await P.evaluate(() => H.newRaw('w'))
		await P.evaluate(() => H.rawCall('w', 'install', { name: 'kora-opfs' }))
		for (const f of ['/f1.db', '/f2.db', '/f3.db', '/f4.db', '/f5.db', '/f6.db'])
			await P.evaluate((f) => H.rawCall('w', 'open', { file: f }), f)
		await P.evaluate(() => {
			for (const f of ['/f1.db', '/f2.db', '/f3.db', '/f4.db', '/f5.db', '/f6.db'])
				H.rawCall('w', 'close', { file: f })
			return true
		})
		await P.evaluate(() => H.killRaw('w'))
		await sleep(300)
		const o = await P.evaluate(() => H.open('k', 'victim'))
		console.log(`       open on full pool: ${J(o)}`)
		await sleep(300)
		const Q = await tab(ctx)
		await Q.evaluate(() => H.newRaw('w'))
		const r = await Q.evaluate(() => H.rawCall('w', 'install', { name: 'kora-opfs' }))
		check(
			'LMS-6c',
			'failed adapter.open() releases the SAH pool (another context can install it)',
			r.ok,
			J(r.error ?? r.data),
		)
		await ctx.close()
	},
	async 'LMS-6b'() {
		// Evaluate the LMS eviction fix verbatim: does it delete another user's live DB?
		const ctx = await browser.newContext()
		const P = await tab(ctx)
		await P.evaluate(() => H.newRaw('w'))
		await P.evaluate(() => H.rawCall('w', 'install', { name: 'kora-opfs' }))
		for (const f of ['/alice.db', '/bob.db', '/carol.db', '/dave.db', '/erin.db', '/frank.db']) {
			await P.evaluate((f) => H.rawCall('w', 'open', { file: f }), f)
			await P.evaluate(
				(f) =>
					H.rawCall('w', 'exec', {
						file: f,
						sql: "CREATE TABLE ops(x); INSERT INTO ops VALUES('unsynced')",
					}),
				f,
			)
			await P.evaluate((f) => H.rawCall('w', 'close', { file: f }), f)
		}
		const r0 = await P.evaluate(() => H.rawCall('w', 'lmsEvictOpen', { file: '/grace.db' }))
		console.log(`       verbatim fix (regex /SAH pool is full/ on error.message): ${J(r0)}`)
		check(
			'LMS-6b',
			'fact: with sqlite-wasm 3.51 the thrown error matches the fix regex /SAH pool is full/',
			r0.ok || /SAH pool is full/i.test(r0.error?.message ?? ''),
			J(r0.error),
		)
		const r = await P.evaluate(() =>
			H.rawCall('w', 'lmsEvictOpen', { file: '/grace.db', anyError: true }),
		)
		console.log(`       fix with matcher widened to CANTOPEN: ${J(r)}`)
		check(
			'LMS-6b',
			"proposed eviction keeps other users' databases (with unsynced ops)",
			r.ok && r.data.files.includes('/alice.db'),
			`evicted=${J(r.data?.evicted)}`,
		)
		await ctx.close()
	},
	// ---------------------------------------------------------------- #7
	async 'LMS-7a'() {
		// Leader tab dies while a follower request is in flight.
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		await A.evaluate(() => H.open('x', 'rpc7a'))
		await B.evaluate(() => H.open('x', 'rpc7a'))
		const cal = await B.evaluate(() => H.slow('x', 3_000_000))
		const n = Math.round(3_000_000 * (6000 / Math.max(cal.ms, 1)))
		console.log(`       calibration: 3e6 rows in ${Math.round(cal.ms)}ms -> using n=${n} (~6s)`)
		await B.evaluate((n) => H.startSlow('x', n), n)
		await sleep(500)
		const t0 = Date.now()
		await A.close({ runBeforeUnload: false })
		const r = await B.evaluate(() => H.awaitSlow())
		const ms = Date.now() - t0
		console.log(`       in-flight result after leader tab close: ${J(r)} (${ms}ms after close)`)
		check(
			'LMS-7a',
			'in-flight follower RPC settles within 5s of leader tab death',
			ms < 5000,
			`${ms}ms, ${r.ok ? 'resolved' : r.error}`,
		)
		const w = await B.evaluate(() => H.insert('x', 'retry-after-promotion'))
		check('LMS-7a', 'retry after promotion succeeds', w.ok, J(w))
		await ctx.close()
	},
	async 'LMS-7b'() {
		// Leader answers the first liveness probe (t=2s), then its main thread becomes
		// unresponsive (t=3s) while the follower's request is still running. Stand-in for a
		// hung/frozen leader tab: a 40s long task on the leader's main thread. (CDP
		// Page.setWebLifecycleState 'frozen' did not stop the relay in headless Chromium.)
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		await A.evaluate(() => H.open('x', 'rpc7b'))
		await B.evaluate(() => H.open('x', 'rpc7b', { timeoutMs: 30000 }))
		const cal = await B.evaluate(() => H.slow('x', 3_000_000))
		const n = Math.round(3_000_000 * (6000 / Math.max(cal.ms, 1)))
		await B.evaluate((n) => H.startSlow('x', n), n)
		await sleep(3000) // the one-shot probe fired at 2000ms and got a pong
		await A.evaluate(() => {
			setTimeout(() => {
				const end = Date.now() + 40_000
				while (Date.now() < end) {}
			}, 0)
			return true
		})
		const t0 = Date.now()
		const r = await B.evaluate(() => H.awaitSlow())
		const ms = Date.now() - t0
		console.log(`       in-flight result: ${J(r)} (${ms}ms after leader hang)`)
		check(
			'LMS-7b',
			'in-flight request detects unresponsive leader within ~2 probe intervals (<6s)',
			ms < 6000,
			`${ms}ms -> ${r.ok ? 'resolved' : r.error}`,
		)
		// Leader still hung and still holding the lock: new request.
		const t1 = Date.now()
		const w = await B.evaluate(() => H.insert('x', 'while-leader-hung'))
		console.log(`       new write while leader hung: ${J(w)} (${Date.now() - t1}ms)`)
		check('LMS-7b', 'follower can still write while leader tab is hung (failover)', w.ok, J(w))
		await ctx.close().catch(() => {})
	},
}

for (const [name, fn] of Object.entries(scenarios)) {
	if (filter && !name.startsWith(filter)) continue
	console.log(`\n=== ${name}`)
	try {
		await fn()
	} catch (e) {
		check(name, 'scenario crashed', false, String(e?.stack ?? e))
	}
}
await browser.close()
server.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
