#!/usr/bin/env node
/**
 * Critical-path bundle budget (first-visit parity, docs/design/first-visit-parity.md, contract
 * K3 in section 2.2, stage S1 in section 11).
 *
 * K3: the JavaScript Kora adds to an app's critical path (what the browser must download
 * before the app's first paint) over the baseline (the same app without Kora). K3 is a RATCHET
 * budget: the enforced limit is the level measured when it was last lowered (it may only go
 * down, in a commit that says why), and the long-term goal is 20 KB gzip, tracked as
 * K3_TARGET_BYTES. What the user feels is first paint (P1), not these bytes; on slow-4g, 28.8 KB gzip is about 137 ms. Measured on a scaffolded template, built for production exactly as a user
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
 *   node scripts/bench/bundle-budget.mjs --baseline base.json  budget = base's measurement + margin
 *                                     (base.json: KORA_BUNDLE_BUDGET_JSON of the same run on base)
 *   node scripts/bench/bundle-budget.mjs --report-only         never fail (prints the gap)
 *   node scripts/bench/bundle-budget.mjs --files               also list the largest Kora source files
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

/**
 * Absolute K3 ratchet of the scaffolded `react-tailwind-sync` template, in bytes (KB = 1,000
 * bytes, as the design's sizes): the last measured value (27,131 at the head of the S4a PR, after
 * the core and store lite splits) plus K3_MARGIN_BYTES. It is the fallback for a run with no
 * baseline; CI compares head against base measured on the same runner (`--baseline`). Lower it
 * when the number drops; never raise it to make a change pass (move code behind a dynamic
 * import() instead).
 */
export const K3_BUDGET_BYTES = 28_200

/**
 * Deterministic margin over the measured value, both for the absolute ratchet and for the
 * head-vs-base comparison. Gzip of the same bytes does not vary, so the margin only has to cover
 * tooling drift, which PINNED_TOOLING removes; 1 KB leaves room for a real change that stays
 * inside the ratchet while still failing growth that matters.
 */
export const K3_MARGIN_BYTES = 1_000

/**
 * Versions of the scaffold's tooling during a measurement. Without them each run resolves
 * whatever the registry serves that day (a new Vite, Rollup, React or Tailwind changes the
 * baseline bytes and the bundler glue), so two runs of the same commit differ. Frameworks and
 * the bundler are pinned; Kora's own packages come from the packed workspace.
 */
export const PINNED_TOOLING = {
	vite: '6.4.5',
	rollup: '4.67.2',
	esbuild: '0.25.12',
	'@vitejs/plugin-react': '4.7.0',
	tailwindcss: '4.3.1',
	'@tailwindcss/vite': '4.3.1',
	typescript: '5.9.3',
	react: '19.2.4',
	'react-dom': '19.2.4',
	scheduler: '0.27.0',
	'lucide-react': '0.468.0',
}

/** The long-term K3 goal (design doc, K3): reached by the core lite split and further deferral. */
export const K3_TARGET_BYTES = 20_000

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
		...PINNED_TOOLING,
		// For a registry that serves a broken release: KORA_BENCH_OVERRIDES='{"rollup":"4.67.2"}'.
		...(process.env.KORA_BENCH_OVERRIDES ? JSON.parse(process.env.KORA_BENCH_OVERRIDES) : {}),
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
	const textByPackage = new Map()
	const byFile = new Map()
	const koraParts = []
	const state = { source: 0 }
	const add = (label, text, source) => {
		if (source !== undefined) {
			const key = `${label}  ${(map.sources[source] ?? '').replace(/^.*?(node_modules\/\.pnpm\/[^/]+\/node_modules\/|packages\/)/, '')}`
			byFile.set(key, (byFile.get(key) ?? 0) + Buffer.byteLength(text))
		}
		byPackage.set(label, (byPackage.get(label) ?? 0) + Buffer.byteLength(text))
		const parts = textByPackage.get(label)
		if (parts) parts.push(text)
		else textByPackage.set(label, [text])
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
			add(label, text, sourceIndex)
			if (pkg !== null && kora.has(pkg)) koraParts.push(text)
		}
	}
	return { byPackage, textByPackage, byFile, koraParts }
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
	const texts = new Map()
	const koraParts = []
	const files = new Map()
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
		for (const [label, parts] of attributed.textByPackage) {
			texts.set(label, [...(texts.get(label) ?? []), ...parts])
		}
		for (const part of attributed.koraParts) koraParts.push(part)
		for (const [file, bytes] of attributed.byFile) files.set(file, (files.get(file) ?? 0) + bytes)
		criticalRaw += Buffer.byteLength(code)
		criticalGzip += gzipSync(code, { level: 9 }).length
	}
	const inline = inlineScripts(dist)
	const inlineRaw = inline.reduce((sum, body) => sum + Buffer.byteLength(body), 0)
	if (inline.length > 0) {
		totals.set('(inline: offline shell registration)', inlineRaw)
		texts.set('(inline: offline shell registration)', inline)
	}
	criticalRaw += inlineRaw
	criticalGzip += inline.length > 0 ? gzipSync(inline.join('\n'), { level: 9 }).length : 0
	const koraCode = [...koraParts, ...inline].join('')
	const koraRaw = Buffer.byteLength(koraCode)
	const koraGzip = gzipSync(koraCode, { level: 9 }).length
	const packages = [...totals.entries()]
		.map(([label, bytes]) => ({
			label,
			bytes,
			// Each package compressed alone (the column does not add up to the total).
			gzipAlone: gzipSync((texts.get(label) ?? []).join(''), { level: 9 }).length,
			kora: kora.has(label) || label === '(inline: offline shell registration)',
		}))
		.sort((a, b) => b.bytes - a.bytes)
	return { chunks, criticalRaw, criticalGzip, koraRaw, koraGzip, packages, files }
}

function main() {
	const template = arg('template', 'react-tailwind-sync')
	const baselinePath = arg('baseline', '')
	// Head against base measured on the same runner with the same pinned tooling: the limit is
	// what base adds plus the margin, so a runner or registry shift moves both numbers together.
	const baseline = baselinePath
		? JSON.parse(readFileSync(resolve(baselinePath), 'utf8')).koraGzip
		: null
	if (baselinePath && !Number.isFinite(baseline))
		throw new Error(`${baselinePath} has no numeric koraGzip`)
	const budget = Number(
		arg('budget', String(baseline === null ? K3_BUDGET_BYTES : baseline + K3_MARGIN_BYTES)),
	)
	const dist = arg('dist', '') ? resolve(arg('dist', '')) : scaffoldAndBuild(template)
	const result = measure(dist)
	const pass = result.koraGzip <= budget
	const lines = [
		`## Critical-path bundle budget (K3 ratchet, first-visit parity): ${pass ? 'PASS' : 'FAIL'}`,
		'',
		`Template: \`${arg('dist', '') ? dist : template}\`; critical chunks: ${result.chunks.map((c) => `\`${c}\``).join(', ')}`,
		'',
		'| Measure | Raw | Gzip (level 9) |',
		'|---|---|---|',
		`| Critical-path JavaScript, total | ${kb(result.criticalRaw)} | ${kb(result.criticalGzip)} |`,
		`| Added by Kora (K3 ratchet ${kb(budget)} gzip${baseline === null ? '' : `, base ${kb(baseline)} + ${kb(K3_MARGIN_BYTES)}`}, long-term goal ${kb(K3_TARGET_BYTES)}) | ${kb(result.koraRaw)} | **${kb(result.koraGzip)}** |`,
		'',
		'| Source (critical path) | Raw | Gzip alone | Counted as Kora |',
		'|---|---|---|---|',
		...result.packages.map(
			(p) => `| ${p.label} | ${kb(p.bytes)} | ${kb(p.gzipAlone)} | ${p.kora ? 'yes' : 'no'} |`,
		),
		'',
	]
	if (pass) {
		lines.push(
			`Kora adds ${kb(result.koraGzip)} gzip to the critical path, within the ${kb(budget)} ratchet; ${kb(Math.max(0, result.koraGzip - K3_TARGET_BYTES))} above the ${kb(K3_TARGET_BYTES)} long-term goal.`,
		)
		if (baseline === null && result.koraGzip < budget - K3_MARGIN_BYTES)
			lines.push(
				`The ratchet can come down: lower K3_BUDGET_BYTES to about ${result.koraGzip + K3_MARGIN_BYTES}.`,
			)
	} else {
		lines.push(
			`Kora adds ${kb(result.koraGzip)} gzip to the critical path: ${kb(result.koraGzip - budget)} over the K3 ratchet of ${kb(budget)}.`,
			'The ratchet only goes down (docs/design/first-visit-parity.md, K3): do not raise it.',
			'Move what the first paint does not need behind a dynamic import().',
		)
	}
	if (flag('files')) {
		// The Kora source files on the critical path, largest first (raw bytes after minification).
		const rows = [...result.files.entries()]
			.filter(([key]) => [...result.packages].some((p) => p.kora && key.startsWith(`${p.label}  `)))
			.sort((a, b) => b[1] - a[1])
			.slice(0, 40)
		lines.push('', '| Kora source file (critical path) | Raw |', '|---|---|')
		for (const [file, bytes] of rows) lines.push(`| ${file.replace('  ', ': ')} | ${kb(bytes)} |`)
		lines.push('')
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
