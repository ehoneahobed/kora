/**
 * Runs matrix checks one at a time, each in its own try/catch, and reports a summary table.
 *
 * A check ends in one of five states:
 *
 *   pass     it ran and every assertion held
 *   fail     it ran and something broke; the detail names what
 *   partial  it ran, but only part of its contract could run here; the detail names what did not
 *   skip     it could not run here (no Postgres, no toolchain); `--strict` turns this into a fail
 *   blocked  it cannot run yet BY DESIGN (a dependency of the plan is unbuilt); never a failure,
 *            but always printed, so it cannot be forgotten
 *   unmet    it was not run because a check it needs failed (the failure is named)
 */
import { appendFileSync } from 'node:fs'

/** Thrown by a check that cannot run in this environment. */
export class Skip extends Error {}

/**
 * Thrown by a check that ran only part of its contract here (the Tauri template without the
 * system libraries to compile Rust). Not a failure, but never a plain PASS; `--strict` fails it.
 */
export class Partial extends Error {}

/** Thrown by a check whose prerequisite does not exist yet in the product. */
export class Blocked extends Error {}

const MARK = {
	pass: 'PASS',
	fail: 'FAIL',
	partial: 'PARTIAL',
	skip: 'SKIP',
	blocked: 'BLOCKED',
	unmet: 'UNMET',
}

function firstLine(message) {
	const text = String(message ?? '').trim()
	return text.split('\n').find((line) => line.trim() !== '') ?? text
}

function seconds(ms) {
	return `${(ms / 1000).toFixed(1)}s`
}

/**
 * @param {Array<{ id: string, title: string, needs?: string[], run: (ctx: any) => Promise<string | void> }>} checks
 * @param {any} ctx
 * @param {{ log: (line: string) => void, strict: boolean }} options
 */
export async function runChecks(checks, ctx, options) {
	/** @type {Map<string, { id: string, title: string, status: string, ms: number, detail: string, output?: string }>} */
	const results = new Map()
	for (const check of checks) {
		const unmet = (check.needs ?? []).filter((id) => results.get(id)?.status !== 'pass')
		if (unmet.length > 0) {
			const missing = unmet.map((id) => `${id} (${results.get(id)?.status ?? 'not selected'})`)
			results.set(check.id, {
				id: check.id,
				title: check.title,
				status: 'unmet',
				ms: 0,
				detail: `needs ${missing.join(', ')}`,
			})
			options.log(`[${MARK.unmet}] ${check.id}: needs ${missing.join(', ')}`)
			continue
		}
		options.log(`\n--- ${check.id}: ${check.title}`)
		const started = Date.now()
		let status = 'pass'
		let detail = ''
		let output
		try {
			detail = (await check.run(ctx)) ?? ''
		} catch (error) {
			if (error instanceof Blocked) {
				status = 'blocked'
				detail = error.message
			} else if (error instanceof Partial) {
				status = options.strict ? 'fail' : 'partial'
				detail = options.strict ? `partial under --strict: ${error.message}` : error.message
			} else if (error instanceof Skip) {
				status = options.strict ? 'fail' : 'skip'
				detail = options.strict ? `skipped under --strict: ${error.message}` : error.message
			} else {
				status = 'fail'
				detail = firstLine(error instanceof Error ? error.message : error)
				output = error instanceof Error ? error.message : String(error)
			}
		}
		const ms = Date.now() - started
		results.set(check.id, { id: check.id, title: check.title, status, ms, detail, output })
		options.log(`[${MARK[status]}] ${check.id} (${seconds(ms)}) ${detail}`)
	}
	return [...results.values()]
}

/** Prints the summary table and, on a CI runner, writes it to the job summary. Returns the exit code. */
export function report(results, options) {
	const width = Math.max(...results.map((result) => result.id.length), 5)
	const lines = [
		'',
		'Packed-artifact release matrix',
		'==============================',
		`${'CHECK'.padEnd(width)}  ${'RESULT'.padEnd(7)}  ${'TIME'.padStart(7)}  DETAIL`,
	]
	for (const result of results) {
		lines.push(
			`${result.id.padEnd(width)}  ${MARK[result.status].padEnd(7)}  ${seconds(result.ms).padStart(7)}  ${firstLine(result.detail)}`,
		)
	}
	const count = (status) => results.filter((result) => result.status === status).length
	lines.push(
		'',
		`${count('pass')} passed, ${count('fail')} failed, ${count('partial')} partial, ${count('unmet')} unmet, ${count('skip')} skipped, ${count('blocked')} blocked by design`,
		`total ${seconds(results.reduce((sum, result) => sum + result.ms, 0))}`,
	)
	const failed = results.filter((result) => result.status === 'fail')
	if (failed.length > 0) {
		lines.push('', 'Failures')
		for (const result of failed) {
			lines.push('', `* ${result.id}: ${result.title}`, indent(result.output ?? result.detail))
		}
	}
	options.log(lines.join('\n'))

	const summaryFile = process.env.GITHUB_STEP_SUMMARY
	if (summaryFile) {
		const rows = results.map(
			(result) =>
				`| \`${result.id}\` | ${MARK[result.status]} | ${seconds(result.ms)} | ${escapeCell(firstLine(result.detail))} |`,
		)
		appendFileSync(
			summaryFile,
			[
				'### Packed-artifact release matrix',
				'',
				'| Check | Result | Time | Detail |',
				'|---|---|---|---|',
				...rows,
				'',
			].join('\n'),
		)
	}
	return failed.length > 0 ? 1 : 0
}

function indent(text) {
	const lines = String(text).trim().split('\n')
	const shown = lines.length > 60 ? [...lines.slice(0, 15), '   [...]', ...lines.slice(-40)] : lines
	return shown.map((line) => `    ${line}`).join('\n')
}

function escapeCell(text) {
	return text.replaceAll('|', '\\|').slice(0, 220)
}
