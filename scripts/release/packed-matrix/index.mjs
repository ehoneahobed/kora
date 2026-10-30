#!/usr/bin/env node
/**
 * The packed-artifact release matrix.
 *
 *   node scripts/release/packed-matrix/index.mjs [options]
 *   pnpm release:matrix -- [options]
 *
 * Packs the 16 publishable packages exactly as `npm publish` would (run `pnpm build` first),
 * then runs every check against the tarballs and prints one summary table. Exit code 1 when any
 * check failed.
 *
 *   --profile smoke|full   smoke (default): everything that needs no Rust toolchain; one template
 *                          through the offline suite. full: adds the Tauri template.
 *   --only a,b             run only these checks (and the checks they need)
 *   --skip a,b             leave these out
 *   --templates a,b|all    templates for the offline suite (default react-tailwind-sync)
 *   --strict               a check that cannot run here (no Postgres) fails instead of skipping
 *   --keep                 keep the work directory (tarballs, scaffolded apps) for inspection
 *   --list                 print the checks and exit
 *   --json <file>          also write the results as JSON
 *
 * Environment: KORA_PG_TEST_URL (a Postgres server to create databases on),
 * KORA_MATRIX_DIR (work directory), KORA_MATRIX_REQUIRE_CARGO_CHECK=1.
 */
import { writeFileSync } from 'node:fs'
import { buildChecks } from './checks.mjs'
import { MatrixContext } from './context.mjs'
import { report, runChecks } from './runner.mjs'

function parseArgs(argv) {
	const options = {
		profile: 'smoke',
		only: null,
		skip: [],
		templates: undefined,
		strict: false,
		keep: false,
		list: false,
		json: null,
	}
	const list = (value) =>
		value
			.split(',')
			.map((entry) => entry.trim())
			.filter(Boolean)
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const next = () => {
			const value = argv[++i]
			if (value === undefined) throw new Error(`${arg} needs a value`)
			return value
		}
		if (arg === '--') continue
		if (arg === '--profile') options.profile = next()
		else if (arg === '--only') options.only = list(next())
		else if (arg === '--skip') options.skip = list(next())
		else if (arg === '--templates') {
			const value = next()
			options.templates = value === 'all' ? 'all' : list(value)
		} else if (arg === '--strict') options.strict = true
		else if (arg === '--keep') options.keep = true
		else if (arg === '--list') options.list = true
		else if (arg === '--json') options.json = next()
		else throw new Error(`unknown option ${arg}`)
	}
	if (!['smoke', 'full'].includes(options.profile)) throw new Error('--profile is smoke or full')
	return options
}

function select(all, options) {
	const byId = new Map(all.map((check) => [check.id, check]))
	for (const id of [...(options.only ?? []), ...options.skip]) {
		if (!byId.has(id)) throw new Error(`unknown check "${id}"; --list shows them`)
	}
	let wanted = all.filter((check) => options.profile === 'full' || check.profile === 'smoke')
	if (options.only) {
		const closure = new Set()
		const add = (id) => {
			if (closure.has(id)) return
			closure.add(id)
			for (const need of byId.get(id)?.needs ?? []) add(need)
		}
		for (const id of options.only) add(id)
		wanted = all.filter((check) => closure.has(check.id))
	}
	return wanted.filter((check) => !options.skip.includes(check.id))
}

const options = parseArgs(process.argv.slice(2))
const all = buildChecks()
if (options.list) {
	for (const check of all) {
		console.log(`${check.id.padEnd(24)} [${check.profile}] ${check.title}`)
	}
	process.exit(0)
}
const checks = select(all, options)
const ctx = new MatrixContext({ keep: options.keep, templates: options.templates })
const log = (line) => process.stdout.write(`${line}\n`)
let code = 1
try {
	log(`Packing the publishable packages into ${ctx.packedDir}`)
	ctx.pack()
	log(
		`Packed ${ctx.archives.size} packages (korajs ${ctx.version('korajs')}); running ${checks.length} checks`,
	)
	const results = await runChecks(checks, ctx, { log, strict: options.strict })
	code = report(results, { log })
	if (options.json) writeFileSync(options.json, `${JSON.stringify(results, null, 2)}\n`)
} catch (error) {
	log(`The matrix could not run: ${error instanceof Error ? error.message : String(error)}`)
} finally {
	if (options.keep) log(`Work directory kept: ${ctx.work}`)
	ctx.cleanup()
}
process.exit(code)
