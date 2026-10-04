#!/usr/bin/env node
// Remediation checker: the single source of truth for fix progress.
//
// It runs every reproduction suite (Node/vitest, optional Postgres, optional real-Chromium,
// tsc type probes), maps each test result to a problem in remediation/tracker.json, and
// enforces these rules:
//   1. A problem marked "fixed" must have every one of its repro tests passing (else: REGRESSION).
//   2. A guard test (passed at baseline) must keep passing (else: GUARD BROKEN).
//   3. Every test under tests/repro that failed at baseline must belong to a problem (else: UNMAPPED).
//   4. An "open"/"in_progress" problem whose repro tests all pass is reported as LOOKS FIXED,
//      so the tracker is updated in the same PR as the fix.
// Observation tests (they describe current HEAD behaviour) may flip after a fix: reported, not fatal.
//
// Usage:
//   node scripts/remediation/check.mjs            # run node suites, check, write remediation/STATUS.md
//   node scripts/remediation/check.mjs --browser  # also run real-Chromium suites
//   node scripts/remediation/check.mjs --tsc      # also run tsc type probes
//   node scripts/remediation/check.mjs --all      # node + browser + tsc (+ Postgres when KORA_PG_TEST_URL is set)
//   node scripts/remediation/check.mjs --baseline # record the current results as the baseline (Phase 0 only)
//   node scripts/remediation/check.mjs --only packages/auth   # run a single package (fast loop while fixing)
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const TRACKER = join(ROOT, 'remediation/tracker.json')
const BASELINE = join(ROOT, 'remediation/baseline.json')
const STATUS = join(ROOT, 'remediation/STATUS.md')
const args = new Set(process.argv.slice(2))
const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null
const all = args.has('--all')
const wantBrowser = all || args.has('--browser')
const wantTsc = all || args.has('--tsc')

const OBSERVATION =
	/HEAD|today:|— but only|shipped matchers|hasDirectionalScopes is true|dump headers/

const PACKAGE_DIRS = ['kora', ...readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}`)]
	.filter((d) => existsSync(join(ROOT, d, 'tests/repro')))
	.filter((d) => !only || d === only)

const BROWSER_SUITES = [
	'packages/store/tests/repro/browser/LMS-5-6-7.browser.mjs',
	'packages/server/tests/repro/browser/NEW-DX-3.offline-shell.mjs',
]
const TSC_PROBES = [
	'kora/tests/repro/types/DX-1.ts',
	'kora/tests/repro/types/DX-2.ts',
	'kora/tests/repro/types/RT-100.ts',
]

// ---------------------------------------------------------------- run suites
const results = new Map() // key -> { status: 'passed'|'failed'|'skipped', kind: 'node'|'browser'|'tsc', file, title, msg }
const tmp = mkdtempSync(join(tmpdir(), 'kora-remediation-'))

for (const dir of PACKAGE_DIRS) {
	const out = join(tmp, `${dir.replaceAll('/', '_')}.json`)
	process.stdout.write(`running ${dir}/tests/repro ... `)
	spawnSync('npx', ['vitest', 'run', 'tests/repro', '--reporter=json', `--outputFile=${out}`], {
		cwd: join(ROOT, dir),
		stdio: 'ignore',
		env: { ...process.env, KORA_REPRO: '1' },
		timeout: 20 * 60_000,
	})
	if (!existsSync(out)) {
		console.log('NO RESULTS (suite crashed)')
		results.set(`${dir}::SUITE`, {
			status: 'failed',
			kind: 'node',
			file: dir,
			title: 'suite crashed',
			msg: '',
		})
		continue
	}
	const json = JSON.parse(readFileSync(out, 'utf8'))
	let n = 0
	for (const file of json.testResults) {
		const rel = relative(ROOT, file.name)
		if (file.assertionResults.length === 0 && file.status === 'failed') {
			results.set(`${rel}::SUITE`, {
				status: 'failed',
				kind: 'node',
				file: basename(rel),
				path: rel,
				title: 'suite failed to load',
				msg: (file.message ?? '').slice(0, 300),
			})
		}
		for (const a of file.assertionResults) {
			n++
			const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped'
			results.set(`${rel}::${a.fullName}`, {
				status,
				kind: 'node',
				file: basename(rel),
				path: rel,
				title: a.fullName,
				msg: (a.failureMessages?.[0] ?? '').slice(0, 300),
			})
		}
	}
	console.log(`${n} tests`)
}

if (wantBrowser && !only) {
	for (const suite of BROWSER_SUITES) {
		process.stdout.write(`running ${suite} (real Chromium) ... `)
		const r = spawnSync('node', [suite], {
			cwd: ROOT,
			encoding: 'utf8',
			timeout: 20 * 60_000,
			env: { PW_CHROMIUM_PATH: '/opt/pw-browsers/chromium', ...process.env },
		})
		let n = 0
		for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) {
			const m = line.match(/^(PASS|FAIL) \[([^\]]+)\] (.*)$/)
			if (!m) continue
			n++
			results.set(`browser::${m[2]}::${m[3]}`, {
				status: m[1] === 'PASS' ? 'passed' : 'failed',
				kind: 'browser',
				file: basename(suite),
				browserId: m[2],
				title: m[3],
				msg: '',
			})
		}
		console.log(`${n} checks`)
	}
}

if (wantTsc && !only) {
	for (const probe of TSC_PROBES) {
		const r = spawnSync(
			'npx',
			[
				'tsc',
				'--noEmit',
				'--strict',
				'--skipLibCheck',
				'--module',
				'esnext',
				'--moduleResolution',
				'bundler',
				'--target',
				'es2022',
				'--jsx',
				'react-jsx',
				relative('kora', probe),
			],
			{ cwd: join(ROOT, 'kora'), encoding: 'utf8' },
		)
		const errors = (r.stdout.match(/error TS/g) ?? []).length
		results.set(`tsc::${probe}`, {
			status: r.status === 0 ? 'passed' : 'failed',
			kind: 'tsc',
			file: probe,
			title: `tsc ${probe}`,
			msg: `${errors} type errors`,
		})
		console.log(`tsc ${probe}: ${errors} errors`)
	}
}

// ---------------------------------------------------------------- baseline
if (args.has('--baseline')) {
	const baseline = {}
	for (const [key, r] of results) {
		if (r.status === 'skipped') continue
		baseline[key] = {
			status: r.status,
			observation: r.status === 'passed' && OBSERVATION.test(r.title),
		}
	}
	writeFileSync(
		BASELINE,
		`${JSON.stringify({ recordedAt: new Date().toISOString(), commit: git('rev-parse', '--short', 'HEAD'), tests: baseline }, null, 1)}\n`,
	)
	console.log(`baseline written: ${Object.keys(baseline).length} results`)
}

// ---------------------------------------------------------------- evaluate
const tracker = JSON.parse(readFileSync(TRACKER, 'utf8'))
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).tests : {}

function owners(key, r) {
	const hits = []
	for (const p of tracker.problems) {
		for (const sel of p.tests) {
			if (sel.browser && r.kind === 'browser' && r.browserId === sel.browser) hits.push(p.id)
			else if (sel.tsc && r.kind === 'tsc' && r.file === sel.tsc) hits.push(p.id)
			else if (
				sel.file &&
				r.kind === 'node' &&
				r.file === sel.file &&
				(!sel.title || r.title.includes(sel.title))
			)
				hits.push(p.id)
		}
	}
	return [...new Set(hits)]
}

function isRejectedProposalPin(r) {
	return (tracker.rejectedProposalPins?.tests ?? []).some((sel) =>
		sel.browser
			? r.kind === 'browser' &&
				r.browserId === sel.browser &&
				(!sel.title || r.title.includes(sel.title))
			: r.kind === 'node' && r.file === sel.file && (!sel.title || r.title.includes(sel.title)),
	)
}

const errors = []
const warnings = []
const perProblem = new Map(tracker.problems.map((p) => [p.id, { repro: [], green: 0, ran: 0 }]))

for (const [key, r] of results) {
	const base = baseline[key]
	const isGuard = base ? base.status === 'passed' && !base.observation : false
	const isObservation = base?.observation === true
	if (isGuard) {
		if (r.status === 'failed') errors.push(`GUARD BROKEN: ${key}\n    ${r.msg}`)
		continue
	}
	if (isObservation) {
		if (r.status === 'failed')
			warnings.push(`OBSERVATION FLIPPED (expected after a fix; invert or delete it): ${key}`)
		continue
	}
	if (isRejectedProposalPin(r)) {
		if (base && r.status !== base.status)
			warnings.push(`REJECTED-PROPOSAL PIN CHANGED (review why): ${key}`)
		continue
	}
	const own = owners(key, r)
	if (own.length === 0) {
		if (r.status === 'failed' && (r.kind !== 'node' || r.path?.includes('tests/repro')))
			errors.push(
				`UNMAPPED failing repro test (add it to a problem in remediation/tracker.json): ${key}`,
			)
		continue
	}
	for (const id of own) {
		const s = perProblem.get(id)
		s.repro.push({ key, status: r.status })
		if (r.status !== 'skipped') s.ran++
		if (r.status === 'passed') s.green++
	}
}

for (const p of tracker.problems) {
	const s = perProblem.get(p.id)
	const allGreen = s.ran > 0 && s.green === s.ran
	if (p.status === 'fixed' && s.ran > 0 && !allGreen)
		errors.push(
			`REGRESSION: ${p.id} is marked fixed but ${s.ran - s.green}/${s.ran} repro tests fail`,
		)
	if (p.status === 'fixed' && s.repro.length === 0 && !p.acceptanceTest)
		errors.push(`${p.id} is marked fixed without any repro or acceptance test`)
	if (
		(p.status === 'open' || p.status === 'in_progress') &&
		allGreen &&
		(wantBrowser || !p.tests.some((t) => t.browser)) &&
		(wantTsc || !p.tests.some((t) => t.tsc))
	)
		warnings.push(
			`LOOKS FIXED: ${p.id} has all ${s.ran} repro tests passing; set status "fixed" (with PR) in remediation/tracker.json`,
		)
}

// ---------------------------------------------------------------- report
const counts = (pred) => tracker.problems.filter(pred).length
const statusOrder = ['fixed', 'mitigated', 'in_progress', 'open', 'wontfix']
const bar = (done, total, width = 24) => {
	const n = total ? Math.round((done / total) * width) : 0
	return `${'█'.repeat(n)}${'░'.repeat(width - n)} ${done}/${total}`
}
const lines = []
lines.push('# Remediation status', '')
lines.push(
	`Generated by \`node scripts/remediation/check.mjs\` at ${new Date().toISOString()} on \`${git('rev-parse', '--abbrev-ref', 'HEAD')}@${git('rev-parse', '--short', 'HEAD')}\`.`,
)
lines.push(
	`Suites run: node${wantBrowser ? ', real Chromium' : ''}${wantTsc ? ', tsc probes' : ''}${process.env.KORA_PG_TEST_URL ? ', Postgres' : ' (Postgres skipped: set KORA_PG_TEST_URL)'}. Do not edit by hand.`,
	'',
)
const total = tracker.problems.length
lines.push(
	`**Overall:** ${bar(
		counts((p) => p.status === 'fixed'),
		total,
	)} fixed, ${counts((p) => p.status === 'mitigated')} mitigated, ${counts((p) => p.status === 'in_progress')} in progress.`,
	'',
)
lines.push(`**Checker:** ${errors.length} errors, ${warnings.length} warnings.`, '')
lines.push('| Severity | Fixed | Total |', '|---|---|---|')
for (const sev of ['P0', 'P1', 'P2', 'P3'])
	lines.push(
		`| ${sev} | ${counts((p) => p.severity === sev && p.status === 'fixed')} | ${counts((p) => p.severity === sev)} |`,
	)
lines.push('')
const phaseNames = [
	'Phase 0: safety net',
	'Phase 1: trust boundary + P0 stopgaps (beta.13)',
	'Phase 2: no silent loss',
	'Phase 3: one fold + durability (beta.13)',
	'Phase 4: encryption, scale, types, DX (RC)',
]
for (let ph = 0; ph <= 4; ph++) {
	const ps = tracker.problems.filter((p) => p.phase === ph || (p.stopgap && p.stopgap.phase === ph))
	lines.push(
		`## ${phaseNames[ph]}`,
		'',
		bar(
			ps.filter((p) => p.status === 'fixed' || (p.phase !== ph && p.stopgap?.status === 'fixed'))
				.length,
			ps.length,
		),
		'',
	)
	lines.push(
		'| ID | Sev | WS | Problem | Status | Repro green | PR |',
		'|---|---|---|---|---|---|---|',
	)
	for (const p of ps.sort(
		(a, b) => a.severity.localeCompare(b.severity) || a.workstream.localeCompare(b.workstream),
	)) {
		const s = perProblem.get(p.id)
		const st = p.phase !== ph ? `stopgap: ${p.stopgap.status}` : p.status
		const repro = p.tests.length === 0 ? 'needs test' : s.ran ? `${s.green}/${s.ran}` : 'not run'
		lines.push(
			`| ${p.id} | ${p.severity} | ${p.phase !== ph ? 'S1' : p.workstream} | ${p.title} | ${st} | ${repro} | ${p.pr ?? ''} |`,
		)
	}
	lines.push('')
}
if (errors.length) lines.push('## Errors', '', ...errors.map((e) => `- ${e.split('\n')[0]}`), '')
if (warnings.length) lines.push('## Warnings', '', ...warnings.map((w) => `- ${w}`), '')
writeFileSync(STATUS, `${lines.join('\n')}\n`)

console.log(
	`\n${counts((p) => p.status === 'fixed')}/${total} fixed | ${errors.length} errors | ${warnings.length} warnings`,
)
for (const e of errors) console.log(`ERROR ${e}`)
for (const w of warnings) console.log(`WARN  ${w}`)
console.log(`status written to ${relative(ROOT, STATUS)}`)
process.exit(errors.length ? 1 : 0)

function git(...a) {
	try {
		return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
	} catch {
		return '?'
	}
}
