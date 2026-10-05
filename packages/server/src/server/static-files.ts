import { createHash } from 'node:crypto'
import { type Stats, createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, join, resolve, sep } from 'node:path'
import {
	brotliCompress,
	brotliDecompress,
	gunzip,
	gzip,
	constants as zlibConstants,
} from 'node:zlib'

/**
 * Static file serving for the production server (NEW-SRV-8).
 *
 * What a production static server for an offline-first app must do, and this does:
 * - Year-long `immutable` caching ONLY for content-hashed file names (Vite's
 *   `name-[hash].ext`). Everything else, including `index.html`, the service worker, the
 *   web manifest and Kora's own UNHASHED `assets/sqlite3.wasm`, is `no-cache`: always
 *   revalidated, so a sqlite upgrade can never pair new JavaScript with stale WASM.
 * - Strong, content-derived validators (RT-99): the `ETag` is a SHA-256 of the file's
 *   bytes, computed once per file version (cached by path, size, mtime, inode and ctime,
 *   re-hashed when any of them changes), so a redeploy that keeps a file's size and
 *   modification time (fixed-length hashes in `index.html`/`sw.js`, reproducible builds
 *   with normalised mtimes) is never answered `304`. Revalidated (`no-cache`) files carry
 *   no `Last-Modified` and ignore `If-Modified-Since`, since an mtime cannot be trusted.
 * - Brotli or gzip for compressible types: a pre-compressed `file.br` / `file.gz` sibling
 *   when the build emitted one and it decompresses to the file's current bytes, otherwise
 *   compressed once per content hash and cached in memory.
 * - A 404 for a missing file. The SPA fallback (`index.html`) answers navigations only
 *   (`Accept: text/html` or `Sec-Fetch-Mode: navigate`) and never a path under
 *   `/assets/`, so a stale tab asking for an old hashed chunk gets a 404, not HTML
 *   parsed as JavaScript.
 * - Correct media types, including `.webmanifest`, `.wasm` and `.mjs`.
 * - No path escapes the static directory: lexically (`..`, encoded separators) nor through
 *   a symbolic link (RT-112). Every file, directory index and pre-compressed sibling is
 *   read from its real path, which must lie inside the static directory's real path; an
 *   escape is a 404. Links that stay inside the directory keep working.
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

interface CachedDigest {
	/** Identity of the file version the digest was computed for. */
	version: string
	digest: string
}

/** Everything that changes when a file is rewritten or replaced (ctime cannot be set). */
function fileVersionKey(stats: Stats): string {
	return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
}

/** Most file versions whose digests are remembered (one entry per served path). */
const DIGEST_CACHE_MAX_ENTRIES = 4096

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
	const digests = new Map<string, CachedDigest>()
	/** Pre-compressed siblings verified against a source digest: `sibling path -> version|digest`. */
	const verifiedSiblings = new Map<string, string>()

	/**
	 * SHA-256 (base64url) of a file's bytes, computed once per file version. The cache key
	 * only decides when to re-hash; the validator itself is always the content digest.
	 */
	async function contentDigest(path: string, stats: Stats): Promise<string> {
		const version = fileVersionKey(stats)
		const cached = digests.get(path)
		if (cached && cached.version === version) return cached.digest
		const hash = createHash('sha256')
		await new Promise<void>((done, fail) => {
			const stream = createReadStream(path)
			stream.on('data', (chunk) => hash.update(chunk))
			stream.on('end', () => done())
			stream.on('error', fail)
		})
		const digest = hash.digest('base64url')
		// Re-insert so the map's order is least-recently-computed first.
		digests.delete(path)
		if (digests.size >= DIGEST_CACHE_MAX_ENTRIES) {
			const oldest = digests.keys().next().value
			if (oldest !== undefined) digests.delete(oldest)
		}
		digests.set(path, { version, digest })
		return digest
	}

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

	async function fileStat(path: string): Promise<Stats | null> {
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

	/**
	 * The real location of `path` when it is inside the real static directory, else null
	 * (RT-112). The lexical check in {@link toFilePath} cannot see symbolic links, which
	 * `stat` and `createReadStream` follow: a link inside the directory may point anywhere.
	 * The root's real path is read per request, so a root that is itself a link (an atomic
	 * `current -> releases/N` deploy) follows its swaps.
	 */
	async function containedRealPath(path: string): Promise<string | null> {
		try {
			const [realRoot, real] = await Promise.all([realpath(root), realpath(path)])
			return real === realRoot || real.startsWith(realRoot + sep) ? real : null
		} catch {
			return null
		}
	}

	/**
	 * The file a URL path names (or its directory's `index.html`), read from its real,
	 * contained location; `name` is the requested path, which decides the headers. A path
	 * whose real location is outside the static directory is "not found", never
	 * "forbidden": the server does not reveal what exists outside it.
	 */
	async function locate(
		pathname: string,
	): Promise<{ path: string; name: string; stats: Stats } | null> {
		const filePath = toFilePath(pathname)
		if (filePath === null) return null
		const real = await containedRealPath(filePath)
		if (real === null) return null
		const stats = await fileStat(real)
		if (stats?.isFile()) return { path: real, name: filePath, stats }
		if (stats?.isDirectory()) {
			const index = join(real, 'index.html')
			const realIndex = await containedRealPath(index)
			if (realIndex === null) return null
			const indexStats = await fileStat(realIndex)
			if (indexStats?.isFile()) {
				return { path: realIndex, name: join(filePath, 'index.html'), stats: indexStats }
			}
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

		const { path, name, stats } = found
		const ext = extname(name).toLowerCase()
		const fileName = basename(name)
		const cacheControl = cacheControlFor(fileName)
		const revalidated = cacheControl === REVALIDATE_CACHE_CONTROL
		const headers: Record<string, string | number> = {
			'Content-Type': STATIC_MIME_TYPES[ext] ?? 'application/octet-stream',
			'Cache-Control': cacheControl,
			'X-Content-Type-Options': 'nosniff',
		}
		// A revalidated file's mtime says nothing about its content (reproducible builds
		// normalise it), so it is never a validator for one (RT-99).
		if (!revalidated) headers['Last-Modified'] = stats.mtime.toUTCString()
		let digest: string
		try {
			digest = await contentDigest(path, stats)
		} catch {
			// Removed or replaced between stat and read: let the client retry.
			res.writeHead(404, {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store',
			})
			res.end(method === 'HEAD' ? undefined : 'Not Found')
			return
		}

		const compressible = COMPRESSIBLE_EXTENSIONS.has(ext) && stats.size >= MIN_COMPRESS_BYTES
		const encoding = compressible ? negotiateEncoding(headerValue(req, 'accept-encoding')) : null
		if (compressible) headers.Vary = 'Accept-Encoding'
		const etag = `"${digest}${encoding ? `-${encoding === 'br' ? 'br' : 'gz'}` : ''}"`
		headers.ETag = etag

		if (isNotModified(req, etag, revalidated ? null : stats.mtime)) {
			res.writeHead(304, headers)
			res.end()
			return
		}

		if (encoding) {
			const body = await compressedBody(path, name, digest, encoding)
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
		name: string,
		digest: string,
		encoding: Encoding,
	): Promise<Buffer> {
		// A pre-compressed sibling the build emitted wins when it holds exactly the file's
		// current bytes (checked once per sibling version and source digest: with
		// normalised mtimes, "not older than the file" proves nothing). It is looked up next
		// to the requested name and read only from a contained real location (RT-112).
		const sibling = await containedRealPath(`${name}${encoding === 'br' ? '.br' : '.gz'}`)
		const siblingStats = sibling === null ? null : await fileStat(sibling)
		if (sibling !== null && siblingStats?.isFile()) {
			const siblingKey = `${fileVersionKey(siblingStats)}|${digest}`
			const body = await readFile(sibling).catch(() => null)
			if (body) {
				if (verifiedSiblings.get(sibling) === siblingKey) return body
				const decoded = await decompress(body, encoding).catch(() => null)
				if (decoded && createHash('sha256').update(decoded).digest('base64url') === digest) {
					verifiedSiblings.set(sibling, siblingKey)
					return body
				}
			}
		}
		// Keyed by the content digest: replaced content never reuses another version's body.
		const key = `${encoding}\0${path}\0${digest}`
		const cached = compressed.get(key)
		if (cached) return cached.body
		const raw = await readFile(path)
		if (createHash('sha256').update(raw).digest('base64url') !== digest) {
			// Changed since it was hashed: compress what was read, but do not cache it under
			// the old digest.
			return compress(raw, encoding)
		}
		const body = await compress(raw, encoding)
		remember(key, body)
		return body
	}
}

function compress(raw: Buffer, encoding: Encoding): Promise<Buffer> {
	return new Promise<Buffer>((done, fail) => {
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
}

function decompress(body: Buffer, encoding: Encoding): Promise<Buffer> {
	return new Promise<Buffer>((done, fail) => {
		const callback = (error: Error | null, result: Buffer): void => {
			if (error) fail(error)
			else done(result)
		}
		if (encoding === 'br') brotliDecompress(body, callback)
		else gunzip(body, callback)
	})
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

/**
 * Conditional GET. `mtime` is null for files whose modification time is not a trusted
 * validator (revalidated files): then only `If-None-Match` can produce a 304.
 */
function isNotModified(req: IncomingMessage, etag: string, mtime: Date | null): boolean {
	const ifNoneMatch = headerValue(req, 'if-none-match')
	if (ifNoneMatch !== undefined) {
		// If-None-Match takes precedence over If-Modified-Since (RFC 9110 13.2.2).
		if (ifNoneMatch.trim() === '*') return true
		const strip = (tag: string): string => tag.trim().replace(/^W\//, '')
		return ifNoneMatch.split(',').some((tag) => strip(tag) === etag)
	}
	const ifModifiedSince = headerValue(req, 'if-modified-since')
	if (ifModifiedSince !== undefined && mtime !== null) {
		const since = Date.parse(ifModifiedSince)
		// HTTP dates have one-second precision.
		if (Number.isFinite(since)) return Math.floor(mtime.getTime() / 1000) * 1000 <= since
	}
	return false
}
