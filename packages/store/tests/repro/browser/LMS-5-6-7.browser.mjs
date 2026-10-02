/**
 * Real-browser reproductions for LMS report items #5, #6, #7 (@korajs/store, OPFS SAH pool + multi-tab).
 *
 * Asserts CORRECT behaviour; checks marked FAIL demonstrate the defect on 1.0.0-beta.12.
 * W8a (OPFS ownership and durability) added LMS-7c/7d, NEW-STORE-7/8/10 and LMS-MIG (a database
 * written by a frozen copy of the beta.12 worker survives the upgrade to per-database pools).
 * LMS-5h and LMS-6b evaluate rejected LMS patches and are expected to keep failing.
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
	async 'LMS-7c'() {
		// W8a step 4: a frozen leader tab releases its storage so a visible tab takes
		// over, and rejoins as a follower on resume. Headless Chromium cannot freeze a
		// page (CDP Page.setWebLifecycleState neither freezes it nor fires `freeze`),
		// so this dispatches the Page Lifecycle `freeze`/`resume` events to exercise
		// Kora's handlers; a real Android background freeze still needs a device run.
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		await A.evaluate(() => H.open('x', 'freeze7c'))
		await B.evaluate(() => H.open('x', 'freeze7c'))
		await A.evaluate(() => H.insert('x', 'before-freeze'))
		await A.evaluate(() => {
			document.dispatchEvent(new Event('freeze'))
			return true
		})
		await sleep(1500)
		const roleB = await B.evaluate(() => H.role('x'))
		const wB = await B.evaluate(() => H.insert('x', 'while-leader-frozen'))
		console.log(`       B role after A froze=${roleB} write=${J(wB)}`)
		check(
			'LMS-7c',
			'frozen leader hands storage to a visible tab (follower promoted, write accepted)',
			roleB === 'leader' && wB.ok,
			`role=${roleB} write=${J(wB)}`,
		)
		await A.evaluate(() => {
			document.dispatchEvent(new Event('resume'))
			return true
		})
		await sleep(1000)
		const wA = await A.evaluate(() => H.insert('x', 'after-resume'))
		const roleA = await A.evaluate(() => H.role('x'))
		console.log(`       A after resume role=${roleA} write=${J(wA)}`)
		await A.evaluate(() => H.close('x'))
		await B.evaluate(() => H.close('x'))
		await sleep(300)
		const C = await tab(ctx)
		await C.evaluate(() => H.open('x', 'freeze7c'))
		const tc = await C.evaluate(() => H.titles('x'))
		check(
			'LMS-7c',
			'resumed tab rejoins and every write from both tabs is durable',
			wA.ok &&
				['before-freeze', 'while-leader-frozen', 'after-resume'].every((t) =>
					tc.titles?.includes(t),
				),
			`resumeWrite=${J(wA)} titles=${J(tc.titles)}`,
		)
		await ctx.close()
	},
	async 'LMS-7d'() {
		// W8a step 4: follower requests carry ids; the leader de-duplicates a retried
		// write instead of applying it twice.
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		await A.evaluate(() => H.open('x', 'dedup7d'))
		await B.evaluate(() => H.open('x', 'dedup7d'))
		const first = await B.evaluate(() => H.insertWithId('x', 'retried', 'req-fixed-1', 'row-a'))
		const retry = await B.evaluate(() => H.insertWithId('x', 'retried', 'req-fixed-1', 'row-b'))
		const t = await A.evaluate(() => H.titles('x'))
		const count = (t.titles ?? []).filter((x) => x === 'retried').length
		check(
			'LMS-7d',
			'a follower write retried with the same request id is applied once',
			first.ok && retry.ok && count === 1,
			`first=${J(first)} retry=${J(retry)} rows=${count}`,
		)
		await ctx.close()
	},
	// ---------------------------------------------------------------- W8a additions
	async 'NEW-STORE-8'() {
		// A failed open releases its worker, the pool and the leader lock, and removes
		// only the file that open created.
		const ctx = await browser.newContext()
		const P = await tab(ctx)
		const pool = await P.evaluate(() => H.poolNameFor('failing_db'))
		const o = await P.evaluate(() => H.open('bad', 'failing_db', { badSchema: true }))
		await sleep(300)
		const locks = await P.evaluate(() => H.locks())
		console.log(`       failed open: ${J(o)}\n       locks after: ${J(locks)}`)
		check(
			'NEW-STORE-8',
			'failed open releases the leader lock and the pool lock',
			!o.ok &&
				!locks.held.includes('kora-leader-failing_db') &&
				!locks.held.includes(`kora-opfs-pool:${pool}`),
			J(locks.held),
		)
		const Q = await tab(ctx)
		await Q.evaluate(() => H.newRaw('w'))
		const r = await Q.evaluate((name) => H.rawCall('w', 'install', { name }), pool)
		check(
			'NEW-STORE-8',
			'failed open frees the pool handles and removes the file it created',
			r.ok && !r.data.files.includes('/failing_db.db'),
			J(r.ok ? r.data : r.error),
		)
		await Q.evaluate(() => H.killRaw('w'))
		await sleep(300)
		await P.evaluate(() => H.open('g', 'kept_db'))
		await P.evaluate(() => H.insert('g', 'precious'))
		await P.evaluate(() => H.close('g'))
		await sleep(200)
		const o2 = await P.evaluate(() => H.open('g2', 'kept_db', { badSchema: true }))
		await sleep(200)
		await P.evaluate(() => H.open('g', 'kept_db'))
		const t = await P.evaluate(() => H.titles('g'))
		check(
			'NEW-STORE-8',
			'failed open of an existing database keeps its file and data',
			!o2.ok && t.ok && t.titles.includes('precious'),
			`open=${J(o2)} titles=${J(t.titles)}`,
		)
		await ctx.close()
	},
	async 'NEW-STORE-10'() {
		// close() stops the worker that owns the pool BEFORE releasing the leader lock,
		// so the next leader never runs while the old worker still holds the pool.
		const ctx = await browser.newContext()
		const A = await tab(ctx)
		const B = await tab(ctx)
		const Obs = await tab(ctx)
		const pool = await A.evaluate(() => H.poolNameFor('handoff10'))
		await A.evaluate(() => H.open('x', 'handoff10'))
		await B.evaluate(() => H.open('x', 'handoff10'))
		await A.evaluate(() => H.insert('x', 'round-0'))
		await Obs.evaluate(
			({ leader, poolLock }) => {
				window.__obs = []
				window.__stop = false
				void (async () => {
					while (!window.__stop) {
						const s = await navigator.locks.query()
						const pick = (n) => (s.held ?? []).find((l) => l.name === n)?.clientId ?? null
						window.__obs.push([pick(leader), pick(poolLock)])
						await new Promise((r) => setTimeout(r, 0))
					}
				})()
				return true
			},
			{ leader: 'kora-leader-handoff10', poolLock: `kora-opfs-pool:${pool}` },
		)
		await sleep(200)
		await A.evaluate(() => H.close('x'))
		await sleep(1500)
		const samples = await Obs.evaluate(() => {
			window.__stop = true
			return window.__obs
		})
		const [leaderA, poolA] = samples[0] ?? [null, null]
		const violations = samples.filter(([l, p]) => l !== null && l !== leaderA && p === poolA)
		const leaders = new Set(samples.map(([l]) => l).filter(Boolean))
		console.log(
			`       ${samples.length} lock samples; leaders seen=${leaders.size}; violations=${violations.length}`,
		)
		check(
			'NEW-STORE-10',
			'leader lock is never granted to the next tab while the old worker still holds the pool',
			poolA !== null && leaders.size >= 2 && violations.length === 0,
			`firstSample=${J(samples[0])} violations=${violations.length}`,
		)
		// Rapid hand-offs: each closing leader hands to a follower that writes at once.
		let current = B
		const roundLog = []
		for (let i = 1; i <= 8; i++) {
			const next = await tab(ctx)
			await next.evaluate(() => H.open('x', 'handoff10'))
			let role = await current.evaluate(() => H.role('x'))
			for (let waited = 0; role !== 'leader' && waited < 3000; waited += 50) {
				await sleep(50)
				role = await current.evaluate(() => H.role('x'))
			}
			const w = await current.evaluate((i) => H.insert('x', `round-${i}`), i)
			roundLog.push({ i, role, write: w.ok ? 'ok' : w.error })
			await current.evaluate(() => H.close('x'))
			current = next
		}
		await current.evaluate(() => H.close('x'))
		await sleep(300)
		const C = await tab(ctx)
		await C.evaluate(() => H.open('x', 'handoff10'))
		const tc = await C.evaluate(() => H.titles('x'))
		const missing = Array.from({ length: 9 }, (_, i) => `round-${i}`).filter(
			(r) => !tc.titles?.includes(r),
		)
		console.log(`       rounds: ${J(roundLog)}`)
		check(
			'NEW-STORE-10',
			'8 consecutive close-to-promotion hand-offs: every promoted leader writes durably',
			roundLog.every((r) => r.role === 'leader' && r.write === 'ok') && missing.length === 0,
			`missing=${J(missing)}`,
		)
		await ctx.close()
	},
	async 'NEW-STORE-7'() {
		// Kora-owned manifest plus explicit list/delete; deletion refuses while the
		// database is open or holds unsynced operations; nothing else is touched.
		const ctx = await browser.newContext()
		const P = await tab(ctx)
		await P.evaluate(() => H.open('a', 'm_alice'))
		await P.evaluate(() => H.insert('a', 'alice-unsynced'))
		await P.evaluate(() => H.open('b', 'm_bob'))
		await P.evaluate(() => H.insert('b', 'bob-row'))
		const list = await P.evaluate(() => H.listDatabases())
		console.log(`       listDatabases: ${J(list)}`)
		check(
			'NEW-STORE-7',
			'listDatabases() reports every database with its backend and pool',
			['m_alice', 'm_bob'].every((n) =>
				list.some((r) => r.dbName === n && r.backend === 'opfs' && r.poolName),
			),
			J(list),
		)
		const inUse = await P.evaluate(() => H.deleteDatabase('m_alice'))
		await P.evaluate(() => H.close('a'))
		await sleep(200)
		const unsynced = await P.evaluate(() => H.deleteDatabase('m_alice', { unsyncedWhenRows: true }))
		console.log(
			`       delete while open: ${J(inUse)}\n       delete with unsynced: ${J(unsynced)}`,
		)
		check(
			'NEW-STORE-7',
			'deleteDatabase() refuses while the database is open and while it has unsynced operations',
			inUse.code === 'STORAGE_IN_USE' && unsynced.code === 'UNSYNCED_DATA',
			`${inUse.code} / ${unsynced.code}`,
		)
		const forced = await P.evaluate(() => H.deleteDatabase('m_alice', { force: true }))
		const after = await P.evaluate(() => H.listDatabases())
		const entries = await P.evaluate(() => H.opfsEntries())
		const alicePool = await P.evaluate(() => H.poolNameFor('m_alice'))
		const bobPool = await P.evaluate(() => H.poolNameFor('m_bob'))
		const bobTitles = await P.evaluate(() => H.titles('b'))
		console.log(`       forced: ${J(forced)} opfs entries: ${J(entries)}`)
		check(
			'NEW-STORE-7',
			'explicit delete removes only that database (pool and manifest entry); others are untouched',
			forced.ok &&
				forced.deleted === true &&
				!after.some((r) => r.dbName === 'm_alice') &&
				!entries.includes(`.${alicePool}`) &&
				entries.includes(`.${bobPool}`) &&
				bobTitles.titles?.includes('bob-row'),
			`after=${J(after)} bob=${J(bobTitles.titles)}`,
		)
		await ctx.close()
	},
	async 'STORE-6'() {
		// IndexedDB fallback, two tabs: only the storage leader restores the snapshot, and only
		// into a fresh worker database. A follower opening must never roll the leader's live
		// database back to the last snapshot, and a promoted follower must start from it.
		const ctx = await browser.newContext()
		const L = await tab(ctx)
		const opts = { indexeddb: true, debounceMs: 60_000 }
		const lo = await L.evaluate((o) => H.open('l', 'store6_idb', o), opts)
		await L.evaluate(() => H.insert('l', 'flushed'))
		await L.evaluate(() => H.flush('l'))
		await L.evaluate(() => H.insert('l', 'unflushed'))
		const F = await tab(ctx)
		const fo = await F.evaluate((o) => H.open('f', 'store6_idb', o), opts)
		const lt = await L.evaluate(() => H.titles('l'))
		const ft = await F.evaluate(() => H.titles('f'))
		console.log(
			`       leader=${J(lo.role)} follower=${J(fo.role)} leaderTitles=${J(lt.titles)} followerTitles=${J(ft.titles)}`,
		)
		check(
			'STORE-6',
			"a follower tab opening keeps the leader's unflushed writes",
			lo.ok &&
				fo.ok &&
				lo.role === 'leader' &&
				fo.role === 'follower' &&
				J(lt.titles) === J(['flushed', 'unflushed']) &&
				J(ft.titles) === J(['flushed', 'unflushed']),
			`leader=${J(lt.titles)} follower=${J(ft.titles)}`,
		)
		await F.evaluate(() => H.insert('f', 'from-follower'))
		// The leader closes (flushes its snapshot); the follower is promoted and restores it
		// into its own fresh worker before serving anything.
		await L.evaluate(() => H.close('l'))
		await L.close()
		let promoted = false
		for (let i = 0; i < 50 && !promoted; i++) {
			await sleep(100)
			promoted = (await F.evaluate(() => H.role('f'))) === 'leader'
		}
		const pt = await F.evaluate(() => H.titles('f'))
		check(
			'STORE-6',
			'a promoted follower restores the last snapshot into its fresh worker database',
			promoted && J(pt.titles) === J(['flushed', 'from-follower', 'unflushed']),
			`promoted=${promoted} titles=${J(pt.titles ?? pt.error)}`,
		)
		await F.evaluate(() => H.insert('f', 'after-promotion'))
		await F.evaluate(() => H.close('f'))
		await sleep(300)
		const R = await tab(ctx)
		await R.evaluate((o) => H.open('r', 'store6_idb', o), opts)
		const rt = await R.evaluate(() => H.titles('r'))
		check(
			'STORE-6',
			'writes made after the promotion survive a reload',
			J(rt.titles) === J(['after-promotion', 'flushed', 'from-follower', 'unflushed']),
			`titles=${J(rt.titles ?? rt.error)}`,
		)
		await R.evaluate(() => H.close('r'))
		await ctx.close()
	},
	async 'LMS-MIG'() {
		// Upgrade path: a database written by 1.0.0-beta.12 (one origin-wide 'kora-opfs'
		// pool) survives the first open under per-database pools.
		const ctx = await browser.newContext()
		const L = await tab(ctx)
		const l1 = await L.evaluate(() => H.legacyOpen('l', 'legacy_app'))
		await L.evaluate(() => H.legacyInsert('l', 'beta12-row'))
		await L.evaluate(() => H.legacyKill('l'))
		await sleep(300)
		await L.evaluate(() => H.legacyOpen('l', 'legacy_other'))
		await L.evaluate(() => H.legacyInsert('l', 'other-row'))
		await L.evaluate(() => H.legacyKill('l'))
		await sleep(300)
		console.log(`       beta.12 open: ${J(l1)}`)

		const N = await tab(ctx)
		const o = await N.evaluate(() => H.open('n', 'legacy_app'))
		const t = await N.evaluate(() => H.titles('n'))
		const ev = await N.evaluate(() => H.events.map((e) => e.type))
		console.log(`       first W8a open: ${J(o)} titles=${J(t.titles)} events=${J(ev)}`)
		check(
			'LMS-MIG',
			'a beta.12 database survives the upgrade (durable, data visible, migration reported)',
			o.ok &&
				o.state?.persistent === true &&
				t.titles?.includes('beta12-row') &&
				ev.includes('store:storage-migrated'),
			`state=${J(o.state)} titles=${J(t.titles)}`,
		)
		const Q = await tab(ctx)
		await Q.evaluate(() => H.newRaw('w'))
		const legacy = await Q.evaluate(() => H.rawCall('w', 'install', { name: 'kora-opfs' }))
		await Q.evaluate(() => H.killRaw('w'))
		check(
			'LMS-MIG',
			'legacy pool is kept while it still holds other databases; the migrated file left it',
			legacy.ok &&
				legacy.data.files.includes('/legacy_other.db') &&
				!legacy.data.files.includes('/legacy_app.db'),
			J(legacy.ok ? legacy.data.files : legacy.error),
		)
		await sleep(300)
		await N.evaluate(() => H.insert('n', 'post-upgrade'))
		await N.evaluate(() => H.close('n'))
		await sleep(300)
		const M = await tab(ctx)
		await M.evaluate(() => H.open('m', 'legacy_app'))
		const tm = await M.evaluate(() => H.titles('m'))
		await M.evaluate(() => H.open('o', 'legacy_other'))
		const to = await M.evaluate(() => H.titles('o'))
		await M.evaluate(() => H.close('o'))
		await M.evaluate(() => H.close('m'))
		await sleep(300)
		const entries = await M.evaluate(() => H.opfsEntries())
		console.log(`       reopen titles=${J(tm.titles)} other=${J(to.titles)} entries=${J(entries)}`)
		check(
			'LMS-MIG',
			'migrated data stays durable across reloads, and the legacy pool is removed after its last database moved',
			tm.titles?.includes('beta12-row') &&
				tm.titles?.includes('post-upgrade') &&
				to.titles?.includes('other-row') &&
				!entries.includes('.kora-opfs'),
			`entries=${J(entries)}`,
		)
		// A beta.12 tab still open and holding the legacy pool: the upgraded tab waits
		// (blocking event), never falls back, and completes once that tab goes away.
		const Z = await tab(ctx)
		await Z.evaluate(() => H.legacyOpen('z', 'legacy_blocked'))
		await Z.evaluate(() => H.legacyInsert('z', 'z-row'))
		const Y = await tab(ctx)
		await Y.evaluate(() => H.startOpen('y', 'legacy_blocked'))
		await sleep(2500)
		const doneWhileHeld = await Y.evaluate(() => H.openDone('y'))
		const yEvents = await Y.evaluate(() =>
			H.events.filter((e) => e.type === 'store:storage-blocked').map((e) => e.state),
		)
		check(
			'LMS-MIG',
			'upgrade waits with a blocking event while a beta.12 tab holds the legacy pool',
			!doneWhileHeld && yEvents.includes('waiting'),
			`done=${doneWhileHeld} blockedEvents=${J(yEvents)}`,
		)
		await Z.evaluate(() => H.legacyKill('z'))
		const yo = await Y.evaluate(() => H.awaitOpen('y'))
		const ty = await Y.evaluate(() => H.titles('y'))
		const yEvents2 = await Y.evaluate(() =>
			H.events.filter((e) => e.type === 'store:storage-blocked').map((e) => e.state),
		)
		check(
			'LMS-MIG',
			'after the beta.12 tab goes away the waiting open completes with the migrated data',
			yo.ok && yo.state?.persistent === true && ty.titles?.includes('z-row'),
			`open=${J(yo.state ?? yo.error)} titles=${J(ty.titles)} blocked=${J(yEvents2)}`,
		)
		await ctx.close()
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
