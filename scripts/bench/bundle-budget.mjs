#!/usr/bin/env node
/**
 * Critical-path bundle budget (first-visit parity, docs/design/first-visit-parity.md, contract
 * K3 in section 2.2, stage S1 in section 11).
 *
 * K3: the JavaScript Kora adds to an app's critical path (what the browser must download
 * before the app's first paint) is at most 20 KB gzip over the baseline (the same app
 * without Kora). Measured on a scaffolded template, built for production exactly as a user
 * builds it, plus a Vite manifest and source maps:
 *
 * - The critical path is the entry chunk of `index.html` and its static imports (the Vite
 *   manifest's `imports`, transitively; dynamic imports load later), plus the inline scripts
 *   of the built `index.html` (the offline shell's registration script).
 * - Each byte of those chunks is attributed, through the source map, to the package it came
 *   from. Kora's bytes are those of korajs, @korajs/* and every package they depend on (their
 *   installed `dependencies` and `peerDependencies`, transitively: Yjs, lib0, protobufjs,
 *   the SQLite glue, ...), except the UI framework (React, Vue, Svelte and their runtime
 *   packages), which the baseline app has too. The app's own code, its other libraries (an
 *   icon set) and the bundler's glue are the baseline.
 * - Kora's gzip size is the gzip (level 9) of its attributed bytes, in bundle order, plus the
 *   inline scripts.
 *
 *   node scripts/bench/bundle-budget.mjs                       scaffold, build, measure
 *   node scripts/bench/bundle-budget.mjs --template vue-sync   another template
 *   node scripts/bench/bundle-budget.mjs --dist <app>/dist     measure an existing build
 *                                     (built with --manifest --sourcemap, its app installed)
 *   node scripts/bench/bundle-budget.mjs --report-only         never fail (prints the gap)
 *
 * Run `pnpm build` first (the scaffold installs the packed workspace packages). Exits 1 when
 * Kora's critical-path JavaScript is over the budget, with the gap. `KORA_BUNDLE_BUDGET_JSON`
 * names a file to write the measurement to.
 */
import { spawnSync } from 'node:child_process'
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/** K3 of the parity contract, in bytes (KB = 1,000 bytes, as the design's sizes). */
export const K3_BUDGET_BYTES = 20_000

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Packages of the baseline app: the UI framework and its runtime. */
const BASELINE_PACKAGES = new Set(['react', 'react-dom', 'scheduler', 'vue', 'svelte', 'esm-env'])
const BASELINE_SCOPES = ['@vue/', '@sveltejs/']

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`)
	return index > -1 ? process.argv[index + 1] : fallback
}

function flag(name) {
	return process.argv.includes(`--${name}`)
}

function run(cmd, args, cwd) {
	const result = spawnSync(cmd, args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, CI: 'true' },
		maxBuffer: 64 * 1024 * 1024,
	})
	if (result.status !== 0) {
		throw new Error(
			`\`${cmd} ${args.join(' ')}\` failed in ${cwd} (exit ${result.status}):\n${(result.stdout ?? '').slice(-3000)}\n${(result.stderr ?? '').slice(-3000)}`,
		)
	}
	return result.stdout
}

/** Packs every publishable workspace package, as `npm publish` would upload it. */
function packWorkspace(dest) {
	mkdirSync(dest, { recursive: true })
	const dirs = ['kora', 'create-kora-app']
	for (const entry of readdirSync(join(REPO_ROOT, 'packages'))) dirs.push(join('packages', entry))
	const packed = []
	for (const dir of dirs) {
		const manifestPath = join(REPO_ROOT, dir, 'package.json')
		if (!existsSync(manifestPath)) continue
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
		if (manifest.private === true) continue
		const archive = join(
			dest,
			`${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`,
		)
		if (!existsSync(archive))
			run('pnpm', ['pack', '--pack-destination', dest], join(REPO_ROOT, dir))
		packed.push({ name: manifest.name, archive })
	}
	return packed
}

/** Scaffolds a template from the workspace CLI, installs the packed packages, builds it. */
function scaffoldAndBuild(template) {
	const root = mkdtempSync(join(tmpdir(), 'kora-bundle-budget-'))
	const packed = packWorkspace(arg('packed', join(root, 'packed')))
	const create = join(REPO_ROOT, 'packages', 'cli', 'dist', 'create.js')
	if (!existsSync(create)) throw new Error(`${create} is missing: run \`pnpm build\` first`)
	console.log(`scaffold ${template} in ${root}`)
	run(process.execPath, [create, 'app', '--template', template, '--skip-install', '--yes'], root)
	const dir = join(root, 'app')
	const manifestPath = join(dir, 'package.json')
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
	manifest.pnpm = manifest.pnpm ?? {}
	manifest.pnpm.overrides = {
		...manifest.pnpm.overrides,
		...Object.fromEntries(packed.map((p) => [p.name, `file:${p.archive}`])),
	}
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
	console.log(`install ${template}`)
	run('pnpm', ['install', '--frozen-lockfile=false'], dir)
	console.log(`build ${template} (with --manifest --sourcemap)`)
	run('pnpm', ['build', '--manifest', '--sourcemap'], dir)
	return join(dir, 'dist')
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_VALUE = new Map([...BASE64].map((char, index) => [char, index]))

/** Decodes one source-map `mappings` line into [generatedColumn, sourceIndex | -1] segments. */
function decodeLine(line, state) {
	const segments = []
	let column = 0
	for (const segment of line.split(',')) {
		if (segment === '') continue
		const values = []
		let value = 0
		let shift = 0
		for (const char of segment) {
			const digit = BASE64_VALUE.get(char)
			if (digit === undefined) throw new Error(`invalid base64 VLQ character ${char}`)
			value += (digit & 31) << shift
			if (digit & 32) {
				shift += 5
			} else {
				const negative = value & 1
				values.push(negative ? -(value >>> 1) : value >>> 1)
				value = 0
				shift = 0
			}
		}
		column += values[0]
		if (values.length >= 4) {
			state.source += values[1]
			segments.push([column, state.source])
		} else {
			segments.push([column, -1])
		}
	}
	return segments
}

/** The package a source path belongs to, or null for the app's own code. */
export function packageOf(source) {
	const at = source.lastIndexOf('node_modules/')
	if (at === -1) return null
	const rest = source.slice(at + 'node_modules/'.length).split('/')
	const first = rest[0] ?? ''
	return first.startsWith('@') ? `${first}/${rest[1] ?? ''}` : first
}

function isFramework(pkg) {
	return BASELINE_PACKAGES.has(pkg) || BASELINE_SCOPES.some((scope) => pkg.startsWith(scope))
}

function isKoraPackage(pkg) {
	return pkg === 'korajs' || pkg.startsWith('@korajs/')
}

/** The installed directory of package `name` as resolved from `fromDir` (Node's lookup). */
function packageDir(name, fromDir) {
	let dir = fromDir
	for (;;) {
		const candidate = join(dir, 'node_modules', name, 'package.json')
		if (existsSync(candidate)) return realpathSync(dirname(candidate))
		const parent = dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

/**
 * The packages Kora brings into an app: korajs and @korajs/* the app installed, and their
 * dependencies and peer dependencies, transitively, minus the UI framework.
 */
export function koraPackages(appDir) {
	const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
	const roots = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
		isKoraPackage,
	)
	const found = new Set()
	const queue = roots.map((name) => ({ name, from: appDir }))
	while (queue.length > 0) {
		const next = queue.shift()
		if (!next || found.has(next.name) || isFramework(next.name)) continue
		const dir = packageDir(next.name, next.from)
		if (dir === null) continue
		found.add(next.name)
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
		for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
			queue.push({ name: dep, from: dir })
		}
	}
	return found
}

/**
 * Attributes every byte of a chunk to the package its source map names. Returns the bytes by
 * package and Kora's bytes in bundle order (for its gzip size).
 */
export function attributeChunk(code, map, kora) {
	const lines = code.split('\n')
	const mappingLines = map.mappings.split(';')
	const sourcePackages = map.sources.map((source) => packageOf(source ?? ''))
	const byPackage = new Map()
	const koraParts = []
	const state = { source: 0 }
	const add = (label, text) => {
		byPackage.set(label, (byPackage.get(label) ?? 0) + Buffer.byteLength(text))
	}
	for (let i = 0; i < lines.length; i++) {
		const line = i < lines.length - 1 ? `${lines[i]}\n` : lines[i]
		const segments = decodeLine(mappingLines[i] ?? '', state)
		if (segments.length === 0) {
			add('(unmapped)', line)
			continue
		}
		if (segments[0][0] > 0) add('(unmapped)', line.slice(0, segments[0][0]))
		for (let s = 0; s < segments.length; s++) {
			const [start, sourceIndex] = segments[s]
			const end = s + 1 < segments.length ? segments[s + 1][0] : line.length
			const text = line.slice(start, end)
			if (sourceIndex < 0) {
				add('(unmapped)', text)
				continue
			}
			const pkg = sourcePackages[sourceIndex] ?? null
			const label = pkg ?? '(app and bundler glue)'
			add(label, text)
			if (pkg !== null && kora.has(pkg)) koraParts.push(text)
		}
	}
	return { byPackage, koraParts }
}

/** The critical-path chunks: the entry of index.html and its static imports, transitively. */
function criticalChunks(dist) {
	const manifestPath = join(dist, '.vite', 'manifest.json')
	if (!existsSync(manifestPath)) {
		throw new Error(`${manifestPath} is missing: build with \`vite build --manifest --sourcemap\``)
	}
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
	const entryKey = Object.keys(manifest).find(
		(key) => manifest[key].isEntry && /(^|\/)index\.html$/.test(key),
	)
	if (!entryKey) throw new Error('the Vite manifest has no index.html entry')
	const files = []
	const visit = (key) => {
		const chunk = manifest[key]
		if (!chunk || files.includes(chunk.file)) return
		files.push(chunk.file)
		for (const imported of chunk.imports ?? []) visit(imported)
	}
	visit(entryKey)
	return files.filter((file) => /\.m?js$/.test(file))
}

function inlineScripts(dist) {
	const html = readFileSync(join(dist, 'index.html'), 'utf8')
	return [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
		.map((match) => match[1] ?? '')
		.filter((body) => body.trim().length > 0)
}

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`

export function measure(dist) {
	const chunks = criticalChunks(dist)
	const kora = koraPackages(dirname(dist))
	const totals = new Map()
	const koraParts = []
	let criticalRaw = 0
	let criticalGzip = 0
	for (const file of chunks) {
		const path = join(dist, file)
		// The sourceMappingURL comment is not shipped without --sourcemap.
		const code = readFileSync(path, 'utf8').replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '')
		const mapPath = `${path}.map`
		if (!existsSync(mapPath)) throw new Error(`${mapPath} is missing: build with --sourcemap`)
		const attributed = attributeChunk(code, JSON.parse(readFileSync(mapPath, 'utf8')), kora)
		for (const [label, bytes] of attributed.byPackage) {
			totals.set(label, (totals.get(label) ?? 0) + bytes)
		}
		for (const part of attributed.koraParts) koraParts.push(part)
		criticalRaw += Buffer.byteLength(code)
		criticalGzip += gzipSync(code, { level: 9 }).length
	}
	const inline = inlineScripts(dist)
	const inlineRaw = inline.reduce((sum, body) => sum + Buffer.byteLength(body), 0)
	if (inline.length > 0) totals.set('(inline: offline shell registration)', inlineRaw)
	criticalRaw += inlineRaw
	criticalGzip += inline.length > 0 ? gzipSync(inline.join('\n'), { level: 9 }).length : 0
	const koraCode = [...koraParts, ...inline].join('')
	const koraRaw = Buffer.byteLength(koraCode)
	const koraGzip = gzipSync(koraCode, { level: 9 }).length
	const packages = [...totals.entries()]
		.map(([label, bytes]) => ({
			label,
			bytes,
			kora: kora.has(label) || label === '(inline: offline shell registration)',
		}))
		.sort((a, b) => b.bytes - a.bytes)
	return { chunks, criticalRaw, criticalGzip, koraRaw, koraGzip, packages }
}

function main() {
	const template = arg('template', 'react-tailwind-sync')
	const budget = Number(arg('budget', String(K3_BUDGET_BYTES)))
	const dist = arg('dist', '') ? resolve(arg('dist', '')) : scaffoldAndBuild(template)
	const result = measure(dist)
	const pass = result.koraGzip <= budget
	const lines = [
		`## Critical-path bundle budget (K3, first-visit parity): ${pass ? 'PASS' : 'FAIL'}`,
		'',
		`Template: \`${arg('dist', '') ? dist : template}\`; critical chunks: ${result.chunks.map((c) => `\`${c}\``).join(', ')}`,
		'',
		'| Measure | Raw | Gzip (level 9) |',
		'|---|---|---|',
		`| Critical-path JavaScript, total | ${kb(result.criticalRaw)} | ${kb(result.criticalGzip)} |`,
		`| Added by Kora (budget K3 ${kb(budget)} gzip) | ${kb(result.koraRaw)} | **${kb(result.koraGzip)}** |`,
		'',
		'| Source (critical path) | Raw | Counted as Kora |',
		'|---|---|---|',
		...result.packages.map((p) => `| ${p.label} | ${kb(p.bytes)} | ${p.kora ? 'yes' : 'no'} |`),
		'',
	]
	if (pass) {
		lines.push(
			`Kora adds ${kb(result.koraGzip)} gzip to the critical path, within the ${kb(budget)} budget.`,
		)
	} else {
		lines.push(
			`Kora adds ${kb(result.koraGzip)} gzip to the critical path: ${kb(result.koraGzip - budget)} over the K3 budget of ${kb(budget)}.`,
			'The budget comes from the parity contract (docs/design/first-visit-parity.md, K3): do not raise it.',
			'Move what the first paint does not need behind a dynamic import() (stage S4a splits korajs into a lite entry and a runtime chunk).',
		)
	}
	const report = lines.join('\n')
	console.log(report)
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
	if (process.env.KORA_BUNDLE_BUDGET_JSON) {
		writeFileSync(
			process.env.KORA_BUNDLE_BUDGET_JSON,
			`${JSON.stringify({ budget, pass, ...result }, null, 2)}\n`,
		)
	}
	if (!pass && !flag('report-only')) process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main()
	} catch (error) {
		console.error(error instanceof Error ? error.message : error)
		process.exit(2)
	}
}
