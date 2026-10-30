import { join } from 'node:path'
import { AUDIT_SKIPPED_DIRECTORIES, type AuditFs, nodeAuditFs } from './audit-fs'
import type { DoctorCheckResult } from './doctor-checks'

/** Stable ids of the static `--production` build and config checks. */
export const PRODUCTION_WORKER_DELIVERY_ID = 'production-worker-delivery'
export const PRODUCTION_ISOLATION_HEADERS_ID = 'production-isolation-headers'
export const PRODUCTION_RUNTIME_STORAGE_ID = 'production-runtime-storage'

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx|svelte|vue)$/
const TEST_FILE = /\.(?:test|spec)\.[^/\\]+$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/

/** Files that configure how a static host sets response headers and media types. */
const HOST_CONFIG_FILES = [
	'vercel.json',
	'netlify.toml',
	'_headers',
	'public/_headers',
	'nginx.conf',
	'Caddyfile',
	'.htaccess',
	'public/.htaccess',
	'staticwebapp.config.json',
	'firebase.json',
	'wrangler.toml',
] as const

/** What the audit reads of the project, once. */
interface ProjectFacts {
	/** Source files (relative path to text), excluding tests and the build output. */
	sources: Map<string, string>
	/** Host configuration files that exist (relative path to text). */
	hostConfigs: Map<string, string>
	/** `.env*` files (relative path to text). */
	envFiles: Map<string, string>
	/** The Vite config text, when there is one. */
	viteConfig: string | null
	/** The build output directory, relative to the project (`dist` unless Vite says otherwise). */
	outDir: string
}

async function readFacts(projectRoot: string, fs: AuditFs): Promise<ProjectFacts> {
	let viteConfig: string | null = null
	for (const name of ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
		viteConfig = await fs.readText(join(projectRoot, name))
		if (viteConfig !== null) break
	}
	const outDir = resolveBuildDir(viteConfig)
	const skip = new Set([...AUDIT_SKIPPED_DIRECTORIES, 'dist', 'build', 'out'])
	const sources = new Map<string, string>()
	for (const file of (await fs.walk(projectRoot, skip)) ?? []) {
		if (!SOURCE_FILE.test(file) || TEST_FILE.test(file) || DECLARATION_FILE.test(file)) continue
		if (file.startsWith(`${outDir}/`)) continue
		const text = await fs.readText(join(projectRoot, file))
		if (text !== null && text.length <= 512 * 1024) sources.set(file, text)
	}
	const hostConfigs = new Map<string, string>()
	for (const name of HOST_CONFIG_FILES) {
		const text = await fs.readText(join(projectRoot, name))
		if (text !== null) hostConfigs.set(name, text)
	}
	const envFiles = new Map<string, string>()
	for (const name of ['.env', '.env.production', '.env.local', '.env.production.local']) {
		const text = await fs.readText(join(projectRoot, name))
		if (text !== null) envFiles.set(name, text)
	}
	return { sources, hostConfigs, envFiles, viteConfig, outDir }
}

/** The Vite `build.outDir` when the config states it as a plain string, else `dist`. */
export function resolveBuildDir(viteConfig: string | null): string {
	const match = viteConfig?.match(/\boutDir\s*:\s*['"`]([^'"`$]+)['"`]/)
	const dir = match?.[1]?.replace(/^\.\//, '').replace(/\/$/, '')
	return dir && dir.length > 0 && !dir.startsWith('/') && !dir.includes('..') ? dir : 'dist'
}

/** The storage adapter the app names (`adapter: 'indexeddb'`), when it names one. */
function configuredAdapter(facts: ProjectFacts): string | null {
	for (const text of facts.sources.values()) {
		const match = text.match(/\badapter\s*:\s*['"](sqlite-wasm|indexeddb|sqlite-native|memory)['"]/)
		if (match?.[1]) return match[1]
	}
	return null
}

/**
 * Worker delivery: the SQLite worker and the WASM binary must be in the built output, as
 * files a static host serves with the right media type. A missing `assets/sqlite3.wasm`
 * (Emscripten asks for that unhashed name), a worker left as `.ts`, or a host rule that
 * serves `.wasm` as anything but `application/wasm` stops the app from opening its database
 * in production while `vite dev` works.
 */
export async function checkWorkerDelivery(
	projectRoot: string,
	fs: AuditFs = nodeAuditFs,
	preloaded?: ProjectFacts,
): Promise<DoctorCheckResult> {
	const id = PRODUCTION_WORKER_DELIVERY_ID
	const title = 'Worker and WASM delivery'
	const facts = preloaded ?? (await readFacts(projectRoot, fs))
	const adapter = configuredAdapter(facts)
	if (adapter === 'indexeddb' || adapter === 'sqlite-native' || adapter === 'memory') {
		return {
			id,
			title,
			status: 'skip',
			message: `The app configures the "${adapter}" adapter, which ships no SQLite worker or WASM binary.`,
		}
	}
	const outDir = facts.outDir
	const built = await fs.walk(join(projectRoot, outDir), new Set())
	if (built === null || built.length === 0) {
		return {
			id,
			title,
			status: 'skip',
			message: `No build output at ${outDir}/, so worker and WASM delivery cannot be checked.`,
			fix: 'Run the production build (for example `pnpm build`) and re-run `kora doctor --production`.',
		}
	}
	const problems: string[] = []
	const wasm = built.filter((file) => file.endsWith('.wasm'))
	if (wasm.length === 0) {
		problems.push(`no .wasm file in ${outDir}/ (the SQLite WASM binary is missing)`)
	} else if (!built.includes('assets/sqlite3.wasm')) {
		problems.push(
			`${wasm.join(', ')} found, but not the unhashed ${outDir}/assets/sqlite3.wasm that the SQLite loader requests`,
		)
	}
	const workers = built.filter((file) => /(^|\/)[^/]*worker[^/]*\.m?js$/i.test(file))
	if (workers.length === 0) {
		problems.push(`no worker script (*worker*.js) in ${outDir}/`)
	}
	const rawSources = built.filter((file) => /\.(?:tsx?|mts)$/.test(file) && !file.endsWith('.d.ts'))
	if (rawSources.length > 0) {
		problems.push(
			`TypeScript files in the output (${rawSources.slice(0, 3).join(', ')}) are served as video/mp2t or octet-stream, never as JavaScript`,
		)
	}
	for (const [file, text] of facts.hostConfigs) {
		const lines = text.split('\n')
		lines.forEach((line, index) => {
			if (!/\bwasm\b/i.test(line)) return
			// The rule's pattern and its Content-Type sit on the same or the next few lines
			// (`_headers`, nginx, Caddy, JSON host files).
			const window = lines.slice(index, index + 4).join('\n')
			if (!/content-type/i.test(window)) return
			const declared = window.match(/(?:application|text)\/[\w.+-]+/i)?.[0]
			if (declared && declared.toLowerCase() !== 'application/wasm') {
				problems.push(`${file} serves .wasm as ${declared}, not application/wasm`)
			}
		})
	}
	if (problems.length > 0) {
		return {
			id,
			title,
			status: 'warn',
			message: `The built output may not deliver the SQLite worker: ${problems.join('; ')}.`,
			fix: 'Build with the template vite.config (its sqlite-wasm-hotfix plugin writes assets/sqlite3.wasm), serve .wasm as application/wasm, and ship the worker as built JavaScript.',
		}
	}
	return {
		id,
		title,
		status: 'pass',
		message: `${outDir}/ has the SQLite WASM binary (assets/sqlite3.wasm) and ${workers.length} worker script(s); no host rule overrides the .wasm media type.`,
	}
}

/** True when the app's own code depends on a feature that needs cross-origin isolation. */
function needsSharedArrayBuffer(facts: ProjectFacts): string | null {
	for (const [file, text] of facts.sources) {
		if (/\bSharedArrayBuffer\b|\bcrossOriginIsolated\b|\bAtomics\.wait/.test(text)) {
			return `${file} uses SharedArrayBuffer or crossOriginIsolated`
		}
	}
	return null
}

/**
 * Isolation headers. Kora's `sqlite-wasm` adapter persists through the `opfs-sahpool` VFS,
 * which needs no `SharedArrayBuffer`, so COOP/COEP are not required and are not asked for.
 * They are required only when the app's own code needs them; and a `require-corp` policy
 * on an app that does not need isolation is reported, since it blocks cross-origin images,
 * fonts and embeds without being asked for.
 */
export async function checkIsolationHeaders(
	projectRoot: string,
	fs: AuditFs = nodeAuditFs,
	preloaded?: ProjectFacts,
): Promise<DoctorCheckResult> {
	const id = PRODUCTION_ISOLATION_HEADERS_ID
	const title = 'Cross-origin isolation headers'
	const facts = preloaded ?? (await readFacts(projectRoot, fs))
	const adapter = configuredAdapter(facts) ?? 'sqlite-wasm'
	const reason = needsSharedArrayBuffer(facts)
	const configured: string[] = [...facts.hostConfigs, ...facts.envFiles, ...facts.sources]
		.map(([file, text]) => ({ file, text }))
		.filter(({ text }) =>
			/Cross-Origin-Embedder-Policy|crossOriginEmbedderPolicy|KORA_COEP_POLICY/i.test(text),
		)
		.map(({ file }) => file)
	const requireCorp = [...facts.hostConfigs, ...facts.envFiles, ...facts.sources].find(([, text]) =>
		/(?:Cross-Origin-Embedder-Policy['"]?\s*[:=,]\s*['"]?|crossOriginEmbedderPolicy\s*:\s*['"]|KORA_COEP_POLICY\s*=\s*['"]?)require-corp/i.test(
			text,
		),
	)

	if (reason === null) {
		if (requireCorp) {
			return {
				id,
				title,
				status: 'warn',
				message: `COEP is set to require-corp in ${requireCorp[0]}, but the "${adapter}" adapter does not need cross-origin isolation (opfs-sahpool uses no SharedArrayBuffer). require-corp blocks cross-origin images, fonts and embeds that do not send a CORP header.`,
				fix: 'Remove the header, or use Cross-Origin-Embedder-Policy: credentialless if you want isolation anyway.',
			}
		}
		return {
			id,
			title,
			status: 'pass',
			message: `COOP/COEP are not required: the "${adapter}" adapter persists through opfs-sahpool, which uses no SharedArrayBuffer${configured.length > 0 ? ` (headers are set in ${configured.join(', ')}; harmless with credentialless)` : ''}.`,
		}
	}
	const servedByKora = [...facts.sources].some(([, text]) =>
		/createProductionServer\s*\(/.test(text),
	)
	const hostSetsHeaders = [...facts.hostConfigs].some(
		([, text]) =>
			/Cross-Origin-Opener-Policy/i.test(text) && /Cross-Origin-Embedder-Policy/i.test(text),
	)
	if (servedByKora || hostSetsHeaders) {
		return {
			id,
			title,
			status: 'pass',
			message: `${reason}; cross-origin isolation headers are set by ${servedByKora ? 'createProductionServer (COOP same-origin, COEP credentialless by default)' : 'the host configuration'}.`,
		}
	}
	return {
		id,
		title,
		status: 'warn',
		message: `${reason}, but no Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy header was found in the host configuration or a createProductionServer call. Without them crossOriginIsolated is false and SharedArrayBuffer is unavailable.`,
		fix: 'Serve Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: credentialless (or require-corp) on the document and its workers, or serve the app with createProductionServer, which sets both.',
	}
}

/**
 * Runtime storage, as far as config and build output show it: nothing here opens a browser.
 * Reports a forced non-durable store, an IndexedDB-only adapter and a sync URL that is not a
 * secure origin (OPFS, service workers and `navigator.storage` need HTTPS outside localhost).
 */
export async function checkRuntimeStorage(
	projectRoot: string,
	fs: AuditFs = nodeAuditFs,
	preloaded?: ProjectFacts,
): Promise<DoctorCheckResult> {
	const id = PRODUCTION_RUNTIME_STORAGE_ID
	const title = 'Runtime storage'
	const facts = preloaded ?? (await readFacts(projectRoot, fs))
	const adapter = configuredAdapter(facts) ?? 'sqlite-wasm'
	const problems: string[] = []
	const fixes: string[] = []

	for (const [file, text] of facts.sources) {
		if (/\ballowNonDurable\s*:\s*true\b/.test(text)) {
			problems.push(
				`${file} sets store.allowNonDurable: true, so writes are accepted when no durable storage exists and are lost on reload`,
			)
			fixes.push('Remove allowNonDurable outside tests; let the app refuse writes it cannot keep.')
		}
	}
	if (adapter === 'indexeddb') {
		problems.push(
			'the app forces the "indexeddb" adapter: no OPFS, and the whole database is rewritten to IndexedDB on each persist, which is slower for large databases',
		)
		fixes.push('Use the default sqlite-wasm adapter; it falls back to IndexedDB by itself.')
	}
	const insecure: string[] = []
	for (const [file, text] of [...facts.envFiles, ...facts.sources]) {
		for (const match of text.matchAll(/\b(?:ws|http):\/\/([A-Za-z0-9.-]+)(?::\d+)?[\w/.-]*/g)) {
			const host = match[1] ?? ''
			if (
				/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(host) ||
				/\.(?:test|local)$/.test(host)
			) {
				continue
			}
			if (/^(?:www\.w3\.org|schemas\.|json-schema\.org)/.test(host) || host.length < 4) continue
			if (/(?:SYNC_URL|syncUrl|sync\s*:|url\s*:)/i.test(lineAround(text, match.index ?? 0))) {
				insecure.push(`${file}: ${match[0]}`)
			}
		}
	}
	if (insecure.length > 0) {
		problems.push(
			`a sync URL is not secure (${[...new Set(insecure)].slice(0, 3).join(', ')}): OPFS, service workers and navigator.storage need a secure context, and browsers block ws:// from an https page`,
		)
		fixes.push('Use wss:// / https:// URLs for every non-local sync endpoint.')
	}
	if (problems.length > 0) {
		return {
			id,
			title,
			status: 'warn',
			message: `Runtime storage may not behave in production: ${problems.join('; ')}.`,
			fix: [...new Set(fixes)].join(' '),
		}
	}
	return {
		id,
		title,
		status: 'pass',
		message: `Static storage config is sound ("${adapter}" adapter, durable writes required, no insecure sync URL). OPFS availability itself is only known in the browser: open the deployed app and confirm no store:storage-fallback event.`,
	}
}

function lineAround(text: string, index: number): string {
	const start = text.lastIndexOf('\n', index) + 1
	const end = text.indexOf('\n', index)
	return text.slice(start, end === -1 ? text.length : end)
}

/**
 * The static `--production` build and config checks, each independent of the others and of
 * whether the schema loaded. Never throws.
 *
 * @param projectRoot - The app
 * @param fs - File access (tests)
 */
export async function runProductionAudit(
	projectRoot: string,
	fs: AuditFs = nodeAuditFs,
): Promise<DoctorCheckResult[]> {
	let facts: ProjectFacts
	try {
		facts = await readFacts(projectRoot, fs)
	} catch (error) {
		const message = `The project files could not be read: ${error instanceof Error ? error.message : String(error)}`
		return [
			[PRODUCTION_WORKER_DELIVERY_ID, 'Worker and WASM delivery'],
			[PRODUCTION_ISOLATION_HEADERS_ID, 'Cross-origin isolation headers'],
			[PRODUCTION_RUNTIME_STORAGE_ID, 'Runtime storage'],
		].map(([id, title]) => ({
			id: id as string,
			title: title as string,
			status: 'skip' as const,
			message,
		}))
	}
	const run = async (
		id: string,
		title: string,
		check: () => Promise<DoctorCheckResult>,
	): Promise<DoctorCheckResult> => {
		try {
			return await check()
		} catch (error) {
			return {
				id,
				title,
				status: 'skip',
				message: `The check could not run: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}
	return [
		await run(PRODUCTION_WORKER_DELIVERY_ID, 'Worker and WASM delivery', () =>
			checkWorkerDelivery(projectRoot, fs, facts),
		),
		await run(PRODUCTION_ISOLATION_HEADERS_ID, 'Cross-origin isolation headers', () =>
			checkIsolationHeaders(projectRoot, fs, facts),
		),
		await run(PRODUCTION_RUNTIME_STORAGE_ID, 'Runtime storage', () =>
			checkRuntimeStorage(projectRoot, fs, facts),
		),
	]
}
