import { createHash } from 'node:crypto'

/**
 * The build id of a Vite build, for Kora's version gate (`docs/design/version-gate.md`,
 * section 3): tabs of two different deployments never write the local database at the
 * same time, which needs an id that differs between any two deployments.
 *
 * The id is a hash of the emitted bundle (every JS chunk and every non-HTML asset, by file
 * name and content), injected into each built HTML page as `<meta name="kora-build">`, which
 * `createApp()` reads when no `build` option is given. The HTML itself is not hashed, so
 * the meta tag never depends on itself. In `vite dev` the id is `dev-<server start time>`:
 * restarting the dev server is a new build.
 */

/** Name of the `<meta>` carrying the build id (read by `createApp()`). */
export const BUILD_META_NAME = 'kora-build'

/** One output file of a Vite/Rollup bundle, as the build id reads it. */
export interface BundleFile {
	type: 'chunk' | 'asset'
	fileName: string
	code?: string
	source?: string | Uint8Array
}

/** The context Vite passes to `transformIndexHtml` (only `bundle` is read). */
export interface IndexHtmlContext {
	bundle?: Record<string, BundleFile>
}

/** An HTML tag a Vite plugin injects. */
export interface BuildIdHtmlTag {
	tag: string
	attrs?: Record<string, string | boolean>
	children?: string
	injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend'
}

/**
 * Hash of a bundle's chunks and non-HTML assets: 16 hex digits, stable for identical
 * output, different when any emitted file differs.
 *
 * @param bundle - The `bundle` of Vite's `transformIndexHtml` context (build only)
 * @returns The build id
 */
export function bundleBuildId(bundle: Record<string, BundleFile>): string {
	const hash = createHash('sha256')
	const files = Object.values(bundle)
		.filter((file) => !file.fileName.endsWith('.html'))
		.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
	for (const file of files) {
		hash.update(file.fileName)
		hash.update('\0')
		const content = file.type === 'chunk' ? (file.code ?? '') : (file.source ?? '')
		hash.update(typeof content === 'string' ? content : Buffer.from(content))
		hash.update('\0')
	}
	return hash.digest('hex').slice(0, 16)
}

/** The `<meta name="kora-build">` tag for `id`. */
export function buildIdTag(id: string): BuildIdHtmlTag {
	return { tag: 'meta', attrs: { name: BUILD_META_NAME, content: id }, injectTo: 'head-prepend' }
}

/**
 * The build id tag for one `transformIndexHtml` call: from the bundle in a build, the dev
 * id in `vite dev`, none when a build passes no bundle.
 */
export function buildIdTagFor(
	command: 'build' | 'serve',
	context: IndexHtmlContext | undefined,
	devId: string,
): BuildIdHtmlTag | null {
	if (command === 'serve') return buildIdTag(devId)
	return context?.bundle ? buildIdTag(bundleBuildId(context.bundle)) : null
}

/** The dev-server build id: one per plugin instance (one per dev-server start). */
export function devBuildId(): string {
	return `dev-${Date.now().toString(36)}`
}

/** The Vite plugin {@link koraBuildId} returns, typed structurally (no `vite` dependency). */
export interface KoraBuildIdPlugin {
	name: string
	enforce: 'post'
	configResolved(config: { command: 'build' | 'serve' }): void
	transformIndexHtml(
		html: string,
		context?: IndexHtmlContext,
	): { html: string; tags: BuildIdHtmlTag[] }
}

/**
 * Vite plugin that gives every build a build id for Kora's version gate, for apps without
 * the offline shell (`koraServiceWorker()` includes it). Without a build id, Kora tells
 * deployments apart only by their schema.
 *
 * @returns A Vite plugin
 *
 * @example
 * ```typescript
 * import { koraBuildId } from '@korajs/cli/vite'
 * export default defineConfig({ plugins: [react(), koraBuildId()] })
 * ```
 */
export function koraBuildId(): KoraBuildIdPlugin {
	let command: 'build' | 'serve' = 'build'
	const devId = devBuildId()
	return {
		name: 'kora-build-id',
		enforce: 'post',
		configResolved(config) {
			command = config.command
		},
		transformIndexHtml(html, context) {
			const tag = buildIdTagFor(command, context, devId)
			return { html, tags: tag ? [tag] : [] }
		},
	}
}
