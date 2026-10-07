#!/usr/bin/env node
/**
 * Relative performance regression check (CLAUDE.md: fail the build on a regression of more
 * than 10%), immune to how fast the machine is.
 *
 * Shared CI runners differ in speed from run to run by more than the 10% buffer of the
 * absolute gates, so an absolute "insert 10,000 records < 2.2 s" either flakes or must be
 * loosened until it catches nothing. Instead this compares the change with its base on the
 * SAME machine in the SAME job: it runs store-workload.mjs alternately against the built
 * base checkout and the built head checkout, keeps each side's fastest run (the run least
 * disturbed by noisy neighbours), and fails when the head is more than 10% slower.
 *
 *   node scripts/bench/ab-regression.mjs --base ../base --head . [--runs 5] [--max-regression 0.10]
 *
 * Both checkouts must be built (`pnpm build`, or at least @korajs/core and @korajs/store).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`)
	return index > -1 ? process.argv[index + 1] : fallback
}

const base = resolve(arg('base', ''))
const head = resolve(arg('head', '.'))
const runs = Number(arg('runs', '5'))
const maxRegression = Number(arg('max-regression', '0.10'))
const workload = join(dirname(fileURLToPath(import.meta.url)), 'store-workload.mjs')
if (!arg('base', '')) {
	console.error('usage: ab-regression.mjs --base <checkout> --head <checkout> [--runs 5]')
	process.exit(2)
}

// Each gated metric, with the absolute slack below which a difference is noise (a 4 ms
// query is not "10% slower" because of 0.5 ms of scheduling jitter).
const METRICS = [
	{ key: 'insertMs', label: 'insert 10,000 records', slackMs: 20 },
	{ key: 'queryMs', label: 'query 1,000 records with WHERE', slackMs: 2 },
]

function measure(checkout) {
	const result = spawnSync(process.execPath, [workload, checkout], { encoding: 'utf8' })
	if (result.status !== 0) {
		throw new Error(`workload failed for ${checkout}:\n${result.stderr || result.stdout}`)
	}
	const line = result.stdout.trim().split('\n').at(-1)
	return JSON.parse(line)
}

const samples = { base: [], head: [] }
for (let run = 0; run < runs; run++) {
	// Alternate the order so neither side always runs on a warmer (or busier) machine.
	const order = run % 2 === 0 ? ['base', 'head'] : ['head', 'base']
	for (const side of order) samples[side].push(measure(side === 'base' ? base : head))
}

let failed = false
const rows = []
for (const metric of METRICS) {
	const baseMs = Math.min(...samples.base.map((s) => s[metric.key]))
	const headMs = Math.min(...samples.head.map((s) => s[metric.key]))
	const change = headMs / baseMs - 1
	const regressed = change > maxRegression && headMs - baseMs > metric.slackMs
	if (regressed) failed = true
	const all = (side) => samples[side].map((s) => s[metric.key].toFixed(1)).join(', ')
	rows.push(
		`| ${metric.label} | ${baseMs.toFixed(1)} ms | ${headMs.toFixed(1)} ms | ${(change * 100).toFixed(1)}% | ${regressed ? 'REGRESSION' : 'ok'} |`,
	)
	const message = `${metric.label}: base ${baseMs.toFixed(1)} ms, head ${headMs.toFixed(1)} ms (${(change * 100).toFixed(1)}%; base runs ${all('base')}; head runs ${all('head')})`
	console.log(`${regressed ? '::error::' : '::notice::'}${message}`)
}

const summary = [
	`### Store performance, head vs base (same runner, fastest of ${runs})`,
	'',
	'| Workload | Base | Head | Change | Result |',
	'|---|---|---|---|---|',
	...rows,
	'',
	`Fails on more than ${(maxRegression * 100).toFixed(0)}% regression.`,
].join('\n')
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
process.exit(failed ? 1 : 0)
