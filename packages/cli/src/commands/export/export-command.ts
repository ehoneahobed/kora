import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { defineCommand } from 'citty'
import { tarHeader } from '../../cloud/source-archive'
import { DataTransferError } from '../../errors'
import { type Logger, createLogger } from '../../utils/logger'

/** Kora's file layout, `<first two hex digits>/<sha256>`, which every Kora file store uses. */
const FILE_NAME = /^[a-f0-9]{64}$/
const BLOCK = 512

export interface ExportOptions {
	/** The app's PostgreSQL database. */
	databaseUrl: string
	/** The folder holding the app's files (`KORA_BLOB_DIR`), or null when it has none. */
	blobDir: string | null
	/** Where the bundle is written. */
	out: string
	/** Folder holding `pg_dump`, or null to find it on PATH. */
	pgBin?: string | null | undefined
	logger?: Logger | undefined
	now?: (() => Date) | undefined
}

export interface ExportResult {
	path: string
	bytes: number
	databaseBytes: number
	files: number
}

/**
 * Bundles an app's whole PostgreSQL database and its files into one `.tar`: the format Kora
 * Cloud's backup downloads use and `kora import` reads. Nothing is changed in the app: the
 * database is read through `pg_dump` from one consistent snapshot, and files are only read.
 */
export async function runExport(options: ExportOptions): Promise<ExportResult> {
	const logger = options.logger ?? createLogger()
	const now = (options.now ?? (() => new Date()))()
	const work = await mkdtemp(join(tmpdir(), 'kora-export-'))
	try {
		logger.step('Dumping the database with pg_dump')
		const dumpPath = join(work, 'database.dump')
		const dump = await pgDump(options.databaseUrl, dumpPath, options.pgBin ?? null)
		logger.step(`Database: ${formatBytes(dump.bytes)}`)

		const files = options.blobDir ? await listFiles(options.blobDir) : []
		if (options.blobDir) logger.step(`Files: ${files.length} in ${options.blobDir}`)

		const out = createWriteStream(options.out, { flags: 'wx' })
		let written = 0
		const write = (bytes: Uint8Array): Promise<void> =>
			new Promise((resolveWrite, reject) => {
				written += bytes.byteLength
				out.write(bytes, (error) => (error ? reject(error) : resolveWrite()))
			})
		const entry = async (
			name: string,
			size: number,
			body: AsyncIterable<Uint8Array> | Uint8Array,
		): Promise<void> => {
			const header = tarHeader(name, 0o644, size)
			if (!header) throw new DataTransferError(`Can't name "${name}" inside the bundle.`)
			await write(header)
			let seen = 0
			for await (const chunk of body instanceof Uint8Array ? [body] : body) {
				seen += chunk.byteLength
				await write(chunk)
			}
			if (seen !== size)
				throw new DataTransferError(
					`"${name}" changed while it was being exported. Run the export again.`,
				)
			const padding = (BLOCK - (size % BLOCK)) % BLOCK
			if (padding) await write(new Uint8Array(padding))
		}

		try {
			const manifest = {
				format: 'kora-export-1',
				createdAt: now.toISOString(),
				database: { sha256: dump.sha256, bytes: dump.bytes },
				files: [] as Array<{ hash: string; bytes: number }>,
				filesIncluded: options.blobDir !== null,
			}
			// Files first are checked against their names while they are read; the manifest lists only
			// the ones written, so it goes last.
			await entry('README.txt', Buffer.byteLength(README), Buffer.from(README))
			await entry('database.dump', dump.bytes, createReadStream(dumpPath))
			for (const file of files) {
				// Read whole (a Kora file is at most a few hundred MiB) so it can be checked before it is written.
				const bytes = await readFile(file.path)
				if (createHash('sha256').update(bytes).digest('hex') !== file.hash) {
					throw new DataTransferError(
						`${file.path} doesn't match its name: Kora names each file by the SHA-256 of its content, so this one is damaged. Restore it from a backup, or remove it, and export again.`,
					)
				}
				await entry(`files/${file.hash.slice(0, 2)}/${file.hash}`, bytes.byteLength, bytes)
				manifest.files.push({ hash: file.hash, bytes: bytes.byteLength })
			}
			const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
			await entry('manifest.json', manifestBytes.byteLength, manifestBytes)
			await write(new Uint8Array(BLOCK * 2))
			await new Promise<void>((resolveEnd, reject) =>
				out.end((error?: Error | null) => (error ? reject(error) : resolveEnd())),
			)
		} catch (error) {
			out.destroy()
			await rm(options.out, { force: true })
			throw error
		}
		return { path: options.out, bytes: written, databaseBytes: dump.bytes, files: files.length }
	} finally {
		await rm(work, { recursive: true, force: true })
	}
}

const README = `A Kora app export, made by \`kora export\`.

database.dump   The app's whole PostgreSQL database, in pg_dump's custom format.
files/          The app's files, each named by the SHA-256 of its content, in Kora's
                <first two hex digits>/<hash> layout.
manifest.json   What the bundle holds, with checksums.

Load it into Kora Cloud:   kora import <this file> --platform kora-cloud
Or restore it yourself:    pg_restore --no-owner --no-privileges --single-transaction -d <database> database.dump
                           then copy files/ into the folder KORA_BLOB_DIR points at.
`

/**
 * Runs pg_dump into `path` and hashes what it wrote. The password goes through the environment,
 * never the command line, so it doesn't show in a process listing.
 */
async function pgDump(
	databaseUrl: string,
	path: string,
	pgBin: string | null,
): Promise<{ bytes: number; sha256: string }> {
	let url: URL
	try {
		url = new URL(databaseUrl)
	} catch {
		throw new DataTransferError('The database address is not a valid postgresql:// URL.')
	}
	if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
		throw new DataTransferError(
			'`kora export` exports PostgreSQL databases. Give it a postgresql:// address.',
		)
	}
	const password = decodeURIComponent(url.password)
	url.password = ''
	const command = pgBin ? join(pgBin, 'pg_dump') : 'pg_dump'
	await new Promise<void>((resolveDump, reject) => {
		const child = spawn(
			command,
			[
				'--format=custom',
				'--no-owner',
				'--no-privileges',
				`--file=${path}`,
				`--dbname=${url.toString()}`,
			],
			{
				env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '30' },
				stdio: ['ignore', 'ignore', 'pipe'],
			},
		)
		let stderr = ''
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderr.length < 8192) stderr += chunk.toString('utf8')
		})
		child.on('error', (error) => {
			reject(
				(error as NodeJS.ErrnoException).code === 'ENOENT'
					? new DataTransferError(
							"pg_dump wasn't found. Install PostgreSQL's client tools (the same major version as the database server, or newer), or point --pg-bin at the folder holding pg_dump.",
						)
					: error,
			)
		})
		child.on('close', (code) => {
			if (code === 0) return resolveDump()
			const line =
				stderr
					.split('\n')
					.find((entry) => /error/i.test(entry))
					?.trim() ??
				stderr.trim().split('\n')[0] ??
				''
			reject(
				new DataTransferError(
					`pg_dump failed: ${line.replace(/postgres(?:ql)?:\/\/\S+/gi, '<database>').slice(0, 300)}`,
				),
			)
		})
	})
	const hash = createHash('sha256')
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
	return { bytes: (await stat(path)).size, sha256: hash.digest('hex') }
}

/** The app's files: anything in the folder that isn't in Kora's layout isn't the app's data. */
async function listFiles(blobDir: string): Promise<Array<{ hash: string; path: string }>> {
	const root = resolve(blobDir)
	let prefixes: string[]
	try {
		prefixes = await readdir(root)
	} catch {
		throw new DataTransferError(`The files folder ${root} doesn't exist or can't be read.`)
	}
	const files: Array<{ hash: string; path: string }> = []
	for (const prefix of prefixes.filter((name) => /^[a-f0-9]{2}$/.test(name)).sort()) {
		for (const name of (await readdir(join(root, prefix))).sort()) {
			if (FILE_NAME.test(name) && name.startsWith(prefix))
				files.push({ hash: name, path: join(root, prefix, name) })
		}
	}
	return files
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function defaultOut(projectRoot: string, now: Date): string {
	const name =
		basename(resolve(projectRoot))
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'kora-app'
	return join(projectRoot, `${name}-export-${now.toISOString().slice(0, 10)}.tar`)
}

export const exportCommand = defineCommand({
	meta: {
		name: 'export',
		description:
			"Bundle the app's whole database and files into one file, to move it to Kora Cloud or another host",
	},
	args: {
		'database-url': {
			type: 'string',
			description: 'PostgreSQL address (default: DATABASE_URL)',
		},
		'blob-dir': {
			type: 'string',
			description:
				"Folder holding the app's files (default: KORA_BLOB_DIR). Leave out for an app without files",
		},
		out: {
			type: 'string',
			description: 'Where to write the bundle (default: <app>-export-<date>.tar)',
		},
		'pg-bin': {
			type: 'string',
			description: 'Folder holding pg_dump, when it is not on PATH',
		},
	},
	async run({ args }) {
		const logger = createLogger()
		const databaseUrl =
			typeof args['database-url'] === 'string' ? args['database-url'] : process.env.DATABASE_URL
		if (!databaseUrl) {
			throw new DataTransferError(
				'No database to export. Set DATABASE_URL, or pass --database-url. `kora export` reads PostgreSQL; a SQLite app can copy its database file instead.',
			)
		}
		const blobDir =
			typeof args['blob-dir'] === 'string' ? args['blob-dir'] : (process.env.KORA_BLOB_DIR ?? null)
		if (!blobDir && process.env.KORA_BLOB_STORE_URL) {
			logger.warn(
				'This app keeps its files in an object store (KORA_BLOB_STORE_URL). Copy them to a folder first, keeping their <aa>/<hash> layout, and pass it as --blob-dir; without it the export holds the database only.',
			)
		}
		const out =
			typeof args.out === 'string' ? resolve(args.out) : defaultOut(process.cwd(), new Date())
		logger.banner()
		const result = await runExport({
			databaseUrl,
			blobDir,
			out,
			pgBin: typeof args['pg-bin'] === 'string' ? args['pg-bin'] : null,
			logger,
		})
		logger.success(`Exported to ${result.path} (${formatBytes(result.bytes)})`)
		logger.step(
			`Load it into Kora Cloud with: kora import ${relativeOrAbsolute(result.path)} --platform kora-cloud`,
		)
		logger.step(
			"The file holds all of the app's data: keep it somewhere safe and delete it when you are done.",
		)
	},
})

function relativeOrAbsolute(path: string): string {
	return dirname(path) === process.cwd() ? basename(path) : path
}
