import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * The build id of a Vite build, for Kora's version gate (`docs/design/version-gate.md`,
 * section 3): tabs of two different deployments never write the local database at the
 * same time, which needs an id that differs between any two deployments.
 *
 * The id is a hash of every deployed file (the JS and CSS chunks, the files copied from
 * `publicDir`, files other plugins write), except the HTML pages that carry it and the
 * offline shell's `sw.js` (derived from the others). Each built HTML page gets a
 * `<meta name="kora-build">` placeholder during the build; once every file is written
 * (`closeBundle`), the placeholder is replaced with the id. `createApp()` reads it when no
 * `build` option is given. In `vite dev` the id is `dev-<server start time>`.
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
			if (entry.name.startsWith('.')) continue
			const full = join(dir, entry.name)
			if (entry.isDirectory()) walk(full)
			else if (entry.isFile()) files.push(full)
		}
	}
	walk(outDir)
	return files
}

/**
 * Hash of every deployed file in `outDir` except HTML pages and `excluded` (the service
 * worker): 16 hex digits. Each file is hashed on its own and the per-file digests are
 * combined with length-prefixed paths, so no two different sets of files share an input.
 *
 * @param outDir - Absolute build directory
 * @param excluded - Output-relative paths (`/` separated) not hashed
 */
export function outputBuildId(outDir: string, excluded: readonly string[] = ['sw.js']): string {
	const skip = new Set(excluded)
	const entries = listFiles(outDir)
		.map((full) => ({ full, rel: relative(outDir, full).split(sep).join('/') }))
		.filter(({ rel }) => !skip.has(rel) && !rel.endsWith('.html'))
		.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
	const combined = createHash('sha256')
	for (const { full, rel } of entries) {
		const digest = createHash('sha256').update(readFileSync(full)).digest('hex')
		combined.update(`${rel.length}:${rel}:${digest};`)
	}
	return combined.digest('hex').slice(0, 16)
}

/**
 * Replace the build id placeholder in every HTML page of `outDir` with `id`.
 *
 * @returns The pages changed
 */
export function stampBuildId(outDir: string, id: string): string[] {
	const stamped: string[] = []
	for (const full of listFiles(outDir)) {
		if (!full.endsWith('.html')) continue
		const html = readFileSync(full, 'utf8')
		if (!html.includes(BUILD_ID_PLACEHOLDER)) continue
		writeFileSync(full, html.split(BUILD_ID_PLACEHOLDER).join(id))
		stamped.push(full)
	}
	return stamped
}

/** Compute the build id of a written build and stamp its pages; returns the id. */
export function stampOutputBuildId(
	outDir: string,
	excluded: readonly string[] = ['sw.js'],
): string {
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
			return { html, tags: [buildIdTagFor(config?.command ?? 'build', devId)] }
		},
		closeBundle: {
			order: 'post',
			sequential: true,
			handler() {
				if (!config || config.command !== 'build') return
				stampOutputBuildId(resolve(config.root, config.build.outDir))
			},
		},
	}
}
