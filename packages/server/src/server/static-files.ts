import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, join, resolve, sep } from 'node:path'
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib'

/**
 * Static file serving for the production server (NEW-SRV-8).
 *
 * What a production static server for an offline-first app must do, and this does:
 * - Year-long `immutable` caching ONLY for content-hashed file names (Vite's
 *   `name-[hash].ext`). Everything else, including `index.html`, the service worker, the
 *   web manifest and Kora's own UNHASHED `assets/sqlite3.wasm`, is `no-cache`: always
 *   revalidated, so a sqlite upgrade can never pair new JavaScript with stale WASM.
 * - Strong validators (`ETag`, `Last-Modified`) and `304 Not Modified`.
 * - Brotli or gzip for compressible types: a pre-compressed `file.br` / `file.gz` sibling
 *   when the build emitted one, otherwise compressed once and cached in memory.
 * - A 404 for a missing file. The SPA fallback (`index.html`) answers navigations only
 *   (`Accept: text/html` or `Sec-Fetch-Mode: navigate`) and never a path under
 *   `/assets/`, so a stale tab asking for an old hashed chunk gets a 404, not HTML
 *   parsed as JavaScript.
 * - Correct media types, including `.webmanifest`, `.wasm` and `.mjs`.
 * - No path escapes the static directory.
 */

/** Media types by extension. Text types carry a charset. */
export const STATIC_MIME_TYPES: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.cjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.wasm': 'application/wasm',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.pdf': 'application/pdf',
	'.mp3': 'audio/mpeg',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
}

const COMPRESSIBLE_EXTENSIONS = new Set([
	'.html',
	'.htm',
	'.js',
	'.mjs',
	'.cjs',
	'.css',
	'.json',
	'.map',
	'.webmanifest',
	'.txt',
	'.xml',
	'.svg',
	'.wasm',
	'.ico',
	'.ttf',
	'.otf',
])

/** Below this, compression costs more than it saves. */
const MIN_COMPRESS_BYTES = 1024
/** On-the-fly compressed bodies kept in memory, so each file is compressed once per deploy. */
const COMPRESSED_CACHE_MAX_BYTES = 32 * 1024 * 1024
/** URL prefix of Vite's emitted assets: never answered with the SPA shell. */
const ASSET_PREFIX = '/assets/'

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const REVALIDATE_CACHE_CONTROL = 'no-cache'

/**
 * Whether a file name carries a content hash in Vite/Rollup's `name-[hash].ext` (or
 * `name.[hash].ext`) form: the token after the last `-` or `.` of the stem is 8 or more
 * `[A-Za-z0-9_]` characters and contains an uppercase letter or a digit. Plain words
 * (`sqlite3-opfs-async-proxy.js`, `my-accounts.js`, `sqlite3.wasm`) do not match, so they
 * are revalidated, never frozen. A real hash this misses (one containing `-`, or all
 * lowercase letters) is merely revalidated with a 304: the safe direction.
 */
export function isContentHashedFileName(fileName: string): boolean {
	const ext = extname(fileName)
	const stem = ext ? fileName.slice(0, -ext.length) : fileName
	const match = /[.-]([A-Za-z0-9_]{8,})$/.exec(stem)
	if (!match) return false
	return /[A-Z0-9]/.test(match[1] as string)
}

/** `Cache-Control` for a served static file. */
export function cacheControlFor(fileName: string): string {
	return isContentHashedFileName(fileName) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL
}

type Encoding = 'br' | 'gzip'

/** The best encoding the client accepts (q > 0), brotli first. */
export function negotiateEncoding(acceptEncoding: string | undefined): Encoding | null {
	if (!acceptEncoding) return null
	const accepted = new Map<string, number>()
	for (const part of acceptEncoding.split(',')) {
		const [rawName, ...params] = part.trim().split(';')
		const name = (rawName ?? '').trim().toLowerCase()
		if (!name) continue
		let q = 1
		for (const param of params) {
			const [key, value] = param.trim().split('=')
			if (key?.trim() === 'q') q = Number(value)
		}
		accepted.set(name, Number.isFinite(q) ? q : 0)
	}
	const wildcard = accepted.get('*')
	const allows = (name: string): boolean => {
		const q = accepted.get(name) ?? wildcard
		return q !== undefined && q > 0
	}
	if (allows('br')) return 'br'
	if (allows('gzip')) return 'gzip'
	return null
}

interface CachedBody {
	body: Buffer
	size: number
}

/** A request handler that serves files from one directory. */
export type StaticFileHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	pathname: string,
) => Promise<void>

/**
 * Create the static file handler for a build directory (`dist/`).
 *
 * @param staticDir - Directory holding the built app
 * @returns A handler answering GET and HEAD for files under `staticDir`
 */
export function createStaticFileHandler(staticDir: string): StaticFileHandler {
	const root = resolve(staticDir)
	const compressed = new Map<string, CachedBody>()
	let compressedBytes = 0

	function remember(key: string, body: Buffer): void {
		if (body.length > COMPRESSED_CACHE_MAX_BYTES / 4) return
		while (compressedBytes + body.length > COMPRESSED_CACHE_MAX_BYTES && compressed.size > 0) {
			const oldest = compressed.keys().next().value as string
			compressedBytes -= compressed.get(oldest)?.size ?? 0
			compressed.delete(oldest)
		}
		compressed.set(key, { body, size: body.length })
		compressedBytes += body.length
	}

	async function fileStat(path: string): Promise<import('node:fs').Stats | null> {
		try {
			return await stat(path)
		} catch {
			return null
		}
	}

	/** Resolve a URL path to a file inside the root, or null when it would escape it. */
	function toFilePath(pathname: string): string | null {
		let decoded: string
		try {
			decoded = decodeURIComponent(pathname)
		} catch {
			return null
		}
		if (decoded.includes('\0')) return null
		const candidate = resolve(join(root, decoded))
		if (candidate !== root && !candidate.startsWith(root + sep)) return null
		return candidate
	}

	async function locate(
		pathname: string,
	): Promise<{ path: string; stats: import('node:fs').Stats } | null> {
		const filePath = toFilePath(pathname)
		if (filePath === null) return null
		const stats = await fileStat(filePath)
		if (stats?.isFile()) return { path: filePath, stats }
		if (stats?.isDirectory()) {
			const index = join(filePath, 'index.html')
			const indexStats = await fileStat(index)
			if (indexStats?.isFile()) return { path: index, stats: indexStats }
		}
		return null
	}

	return async function serveStatic(req, res, pathname) {
		const method = req.method ?? 'GET'
		if (method !== 'GET' && method !== 'HEAD') {
			res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
			res.end('Method Not Allowed')
			return
		}

		let found = await locate(pathname)
		if (!found && isNavigation(req) && !pathname.startsWith(ASSET_PREFIX)) {
			found = await locate('/index.html')
		}
		if (!found) {
			res.writeHead(404, {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store',
			})
			res.end(method === 'HEAD' ? undefined : 'Not Found')
			return
		}

		const { path, stats } = found
		const ext = extname(path).toLowerCase()
		const fileName = basename(path)
		const headers: Record<string, string | number> = {
			'Content-Type': STATIC_MIME_TYPES[ext] ?? 'application/octet-stream',
			'Cache-Control': cacheControlFor(fileName),
			'Last-Modified': stats.mtime.toUTCString(),
			'X-Content-Type-Options': 'nosniff',
		}
		const baseTag = `${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}`

		const compressible = COMPRESSIBLE_EXTENSIONS.has(ext) && stats.size >= MIN_COMPRESS_BYTES
		const encoding = compressible ? negotiateEncoding(headerValue(req, 'accept-encoding')) : null
		if (compressible) headers.Vary = 'Accept-Encoding'
		const etag = `"${baseTag}${encoding ? `-${encoding === 'br' ? 'br' : 'gz'}` : ''}"`
		headers.ETag = etag

		if (isNotModified(req, etag, stats.mtime)) {
			res.writeHead(304, headers)
			res.end()
			return
		}

		if (encoding) {
			const body = await compressedBody(path, stats, encoding)
			headers['Content-Encoding'] = encoding
			headers['Content-Length'] = body.length
			res.writeHead(200, headers)
			res.end(method === 'HEAD' ? undefined : body)
			return
		}

		headers['Content-Length'] = stats.size
		res.writeHead(200, headers)
		if (method === 'HEAD') {
			res.end()
			return
		}
		createReadStream(path).pipe(res)
	}

	async function compressedBody(
		path: string,
		stats: import('node:fs').Stats,
		encoding: Encoding,
	): Promise<Buffer> {
		// A pre-compressed sibling the build emitted wins, when it is not older than the file.
		const sibling = `${path}${encoding === 'br' ? '.br' : '.gz'}`
		const siblingStats = await fileStat(sibling)
		if (siblingStats?.isFile() && siblingStats.mtimeMs >= stats.mtimeMs) {
			return readFile(sibling)
		}
		const key = `${encoding}\0${path}\0${stats.size}\0${stats.mtimeMs}`
		const cached = compressed.get(key)
		if (cached) return cached.body
		const raw = await readFile(path)
		const body = await new Promise<Buffer>((done, fail) => {
			const callback = (error: Error | null, result: Buffer): void => {
				if (error) fail(error)
				else done(result)
			}
			if (encoding === 'br') {
				brotliCompress(
					raw,
					{
						params: {
							// Quality 5: close to 9 in size at a fraction of the CPU, for a one-time compress.
							[zlibConstants.BROTLI_PARAM_QUALITY]: 5,
							[zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
						},
					},
					callback,
				)
			} else {
				gzip(raw, { level: 6 }, callback)
			}
		})
		remember(key, body)
		return body
	}
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name]
	return Array.isArray(value) ? value.join(', ') : value
}

/** A browser navigation: the only request the SPA shell may answer for a missing path. */
function isNavigation(req: IncomingMessage): boolean {
	if (headerValue(req, 'sec-fetch-mode') === 'navigate') return true
	const accept = headerValue(req, 'accept') ?? ''
	return /(^|[,\s])text\/html\b/i.test(accept)
}

function isNotModified(req: IncomingMessage, etag: string, mtime: Date): boolean {
	const ifNoneMatch = headerValue(req, 'if-none-match')
	if (ifNoneMatch !== undefined) {
		// If-None-Match takes precedence over If-Modified-Since (RFC 9110 13.2.2).
		if (ifNoneMatch.trim() === '*') return true
		const strip = (tag: string): string => tag.trim().replace(/^W\//, '')
		return ifNoneMatch.split(',').some((tag) => strip(tag) === etag)
	}
	const ifModifiedSince = headerValue(req, 'if-modified-since')
	if (ifModifiedSince !== undefined) {
		const since = Date.parse(ifModifiedSince)
		// HTTP dates have one-second precision.
		if (Number.isFinite(since)) return Math.floor(mtime.getTime() / 1000) * 1000 <= since
	}
	return false
}
