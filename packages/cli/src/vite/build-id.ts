import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

/**
 * The build id of a Vite build, for Kora's version gate (`docs/design/version-gate.md`,
 * section 3): tabs of two different deployments never write the local database at the
 * same time, which needs an id that differs between any two deployments.
 *
 * The id is a hash of every deployed file (the JS and CSS chunks, the HTML pages with their
 * build id normalized, the files copied from `publicDir`, a `sw.js` the app ships itself,
 * files other plugins write), except the worker `koraServiceWorker()` generates (derived
 * from the others), sourcemaps (`.map`: they can differ by build machine for identical
 * code), precompressed copies of another emitted file (`app.js.gz` next to `app.js`; a
 * standalone `.gz`/`.br` asset is hashed), and dotfiles and dot-directories (never served by
 * most hosts). Each built HTML page gets a `<meta name="kora-build">` placeholder during the
 * build (an existing tag has its content replaced); once every file is written
 * (`closeBundle`), the placeholder in that tag (and only there) is replaced with the id, and
 * precompressed copies of a stamped page (`index.html.gz`, `.br`) are regenerated.
 * `createApp()` reads it when no `build` option is given.
 *
 * In `vite dev` the id is `dev-<server start time>`: it changes on every dev-server restart,
 * so tabs left open across a restart show the "new version" prompt (reload them).
 *
 * Use one of `koraBuildId()` and `koraServiceWorker()` (which includes it). With both, the
 * meta tag is injected once and both compute the same id.
 */

/** Name of the `<meta>` carrying the build id (read by `createApp()`). */
export const BUILD_META_NAME = 'kora-build'

/** Content of the meta tag until the build is written and the id is known. */
export const BUILD_ID_PLACEHOLDER = '__KORA_BUILD_ID__'

/** An HTML tag a Vite plugin injects. */
export interface BuildIdHtmlTag {
	tag: string
	attrs?: Record<string, string | boolean>
	children?: string
	injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend'
}

/** The `<meta name="kora-build">` tag for `id`. */
export function buildIdTag(id: string): BuildIdHtmlTag {
	return { tag: 'meta', attrs: { name: BUILD_META_NAME, content: id }, injectTo: 'head-prepend' }
}

/** The tag to inject: the dev id in `vite dev`, the placeholder in a build. */
export function buildIdTagFor(command: 'build' | 'serve', devId: string): BuildIdHtmlTag {
	return buildIdTag(command === 'serve' ? devId : BUILD_ID_PLACEHOLDER)
}

/** The dev-server build id: one per plugin instance (one per dev-server start). */
export function devBuildId(): string {
	return `dev-${Date.now().toString(36)}`
}

function listFiles(outDir: string): string[] {
	const files: string[] = []
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			// Dotfiles and dot-directories (`.well-known` aside, rarely deployed) are not hashed.
			if (entry.name.startsWith('.')) continue
			const full = join(dir, entry.name)
			if (entry.isDirectory()) walk(full)
			else if (entry.isFile()) files.push(full)
		}
	}
	walk(outDir)
	return files
}

/** Every `<meta ...>` tag of a page. */
const META_TAG = /<meta\b[^>]*>/gi
/** A `name="kora-build"` attribute (either quote, any attribute order). */
const BUILD_NAME_ATTR = /\bname\s*=\s*(["'])kora-build\1/i
/** A `content="..."` attribute. */
const CONTENT_ATTR = /(\bcontent\s*=\s*)(["'])([^"']*)\2/i

/**
 * Rewrite the content of every `kora-build` meta tag of `html` (and nothing else of the
 * page); a tag without a content attribute gets one.
 */
export function rewriteBuildMeta(html: string, content: (current: string) => string): string {
	return html.replace(META_TAG, (tag) => {
		if (!BUILD_NAME_ATTR.test(tag)) return tag
		if (CONTENT_ATTR.test(tag)) {
			return tag.replace(
				CONTENT_ATTR,
				(_match, prefix: string, quote: string, current: string) =>
					`${prefix}${quote}${content(current)}${quote}`,
			)
		}
		return tag.replace(/\s*\/?>$/, (end) => ` content="${content('')}"${end}`)
	})
}

/** Whether `html` already has a kora-build meta tag (authored, or another plugin's). */
export function hasBuildIdTag(html: string): boolean {
	return (html.match(META_TAG) ?? []).some((tag) => BUILD_NAME_ATTR.test(tag))
}

/**
 * The page with its build id for this command: an existing `kora-build` tag gets its content
 * replaced (an authored constant never survives into a build), otherwise the tag is injected.
 */
export function withBuildIdTag(
	html: string,
	command: 'build' | 'serve',
	devId: string,
): { html: string; tags: BuildIdHtmlTag[] } {
	const content = command === 'serve' ? devId : BUILD_ID_PLACEHOLDER
	if (hasBuildIdTag(html)) return { html: rewriteBuildMeta(html, () => content), tags: [] }
	return { html, tags: [buildIdTag(content)] }
}

/** Precompressed copies the build id step knows (regenerated after stamping). */
const COMPRESSED_COPY = /\.(gz|br)$/

/**
 * Not hashed (and not precached by the offline shell): sourcemaps, and precompressed copies
 * of another emitted file (their content is that file's). A standalone `.gz`/`.br` asset is
 * application content: hashed and precached.
 */
export function isUnhashed(full: string): boolean {
	if (full.endsWith('.map')) return true
	return COMPRESSED_COPY.test(full) && existsSync(full.replace(COMPRESSED_COPY, ''))
}

/**
 * Hash of every deployed file in `outDir` except `excluded` (the service worker, derived from
 * the others): 16 hex digits. HTML pages are hashed with their build id normalized to the
 * placeholder, so a change to an inline script, an import map or a page's configuration
 * changes the id while stamping the id does not. Each file is hashed on its own and the
 * per-file digests are combined with length-prefixed paths, so no two different sets of
 * files share an input.
 *
 * @param outDir - Absolute build directory
 * @param excluded - Output-relative paths (`/` separated) not hashed (`koraServiceWorker()`
 *   passes the worker it generates; nothing by default)
 */
export function outputBuildId(outDir: string, excluded: readonly string[] = []): string {
	const skip = new Set(excluded)
	const entries = listFiles(outDir)
		.map((full) => ({ full, rel: relative(outDir, full).split(sep).join('/') }))
		.filter(({ full, rel }) => !skip.has(rel) && !isUnhashed(full))
		.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
	const combined = createHash('sha256')
	for (const { full, rel } of entries) {
		const bytes = readFileSync(full)
		const content = rel.endsWith('.html')
			? rewriteBuildMeta(bytes.toString('utf8'), () => BUILD_ID_PLACEHOLDER)
			: bytes
		const digest = createHash('sha256').update(content).digest('hex')
		combined.update(`${rel.length}:${rel}:${digest};`)
	}
	return combined.digest('hex').slice(0, 16)
}

/**
 * Replace the build id placeholder in the `kora-build` meta tag of every HTML page of
 * `outDir` with `id` (the same string elsewhere in a page is application content and stays),
 * and regenerate the page's precompressed copies (`.gz`, `.br`) a compression plugin already
 * wrote, so a server negotiating them never sends the placeholder.
 *
 * @returns The pages changed
 */
export function stampBuildId(outDir: string, id: string): string[] {
	const stamped: string[] = []
	for (const full of listFiles(outDir)) {
		if (!full.endsWith('.html')) continue
		const html = readFileSync(full, 'utf8')
		const next = rewriteBuildMeta(html, (current) =>
			current === BUILD_ID_PLACEHOLDER ? id : current,
		)
		if (next === html) continue
		writeFileSync(full, next)
		const bytes = Buffer.from(next, 'utf8')
		if (existsSync(`${full}.gz`)) writeFileSync(`${full}.gz`, gzipSync(bytes, { level: 9 }))
		if (existsSync(`${full}.br`)) writeFileSync(`${full}.br`, brotliCompressSync(bytes))
		stamped.push(full)
	}
	return stamped
}

/** Compute the build id of a written build and stamp its pages; returns the id. */
export function stampOutputBuildId(outDir: string, excluded: readonly string[] = []): string {
	const id = outputBuildId(outDir, excluded)
	stampBuildId(outDir, id)
	return id
}

/** The subset of Vite's resolved config {@link koraBuildId} reads. */
interface BuildIdViteConfig {
	root: string
	command: 'build' | 'serve'
	build: { outDir: string }
}

/** The Vite plugin {@link koraBuildId} returns, typed structurally (no `vite` dependency). */
export interface KoraBuildIdPlugin {
	name: string
	enforce: 'post'
	configResolved(config: BuildIdViteConfig): void
	transformIndexHtml(html: string): { html: string; tags: BuildIdHtmlTag[] }
	closeBundle: { order: 'post'; sequential: true; handler(): void }
}

/**
 * Vite plugin that gives every build a build id for Kora's version gate, for apps without
 * the offline shell (`koraServiceWorker()` includes it). Without a build id, Kora tells
 * deployments apart only by their schema.
 *
 * @returns A Vite plugin (add it last in `plugins`)
 *
 * @example
 * ```typescript
 * import { koraBuildId } from '@korajs/cli/vite'
 * export default defineConfig({ plugins: [react(), koraBuildId()] })
 * ```
 */
export function koraBuildId(): KoraBuildIdPlugin {
	let config: BuildIdViteConfig | null = null
	const devId = devBuildId()
	return {
		name: 'kora-build-id',
		enforce: 'post',
		configResolved(resolved) {
			config = resolved
		},
		transformIndexHtml(html) {
			// Once per page, also when `koraServiceWorker()` injected it already; an authored
			// tag gets its content replaced.
			return withBuildIdTag(html, config?.command ?? 'build', devId)
		},
		closeBundle: {
			order: 'post',
			sequential: true,
			handler() {
				if (!config || config.command !== 'build') return
				// Everything emitted is hashed, a `sw.js` the app ships included.
				stampOutputBuildId(resolve(config.root, config.build.outDir))
			},
		},
	}
}
