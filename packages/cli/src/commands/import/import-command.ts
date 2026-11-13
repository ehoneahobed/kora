import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineCommand } from 'citty'
import { type CloudBackup, KoraCloudClient } from '../../cloud/cloud-client'
import { readCredentials } from '../../cloud/credentials'
import { readProjectLink } from '../../cloud/project-link'
import { DataTransferError, KoraCloudSignInRequiredError } from '../../errors'
import { type Logger, createLogger } from '../../utils/logger'
import { readTar } from './tar-reader'

/** Azure allows 50,000 blocks per blob; 16 MiB blocks reach 780 GiB. */
const BLOCK_BYTES = 16 * 1024 * 1024
const ATTEMPTS = 5

export interface CloudImportOptions {
	file: string
	projectRoot: string
	client?: KoraCloudClient | undefined
	logger?: Logger | undefined
	fetchImpl?: typeof fetch | undefined
	sleep?: ((milliseconds: number) => Promise<void>) | undefined
	pollMs?: number | undefined
	blockBytes?: number | undefined
	/**
	 * Accept exactly this many operations whose ids aren't their content hashes: written by the
	 * app's own tools around the server's checks. Use the count a refused import reported.
	 */
	acceptUnverified?: number | undefined
}

/** `--accept-unverified`: a positive whole number, or absent. */
export function parseAcceptUnverified(value: unknown): number | undefined {
	if (value === undefined || value === false) return undefined
	const text = String(value).trim()
	if (!/^[1-9][0-9]{0,8}$/.test(text)) {
		throw new DataTransferError(
			'--accept-unverified takes the number of operations a refused import reported, for example --accept-unverified 120.',
		)
	}
	return Number(text)
}

/**
 * Imports a bundle (`kora export`, or a backup downloaded from Kora Cloud) into the linked
 * project. The file goes straight to the environment's own backup storage through a link that
 * can write that one file; Kora Cloud then verifies it like any backup. The app's live data is
 * not touched: loading the import into production is a separate step in the console.
 */
export async function runCloudImport(options: CloudImportOptions): Promise<CloudBackup> {
	const logger = options.logger ?? createLogger()
	const sleep =
		options.sleep ??
		((milliseconds: number) =>
			new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)))
	const pollMs = options.pollMs ?? 3000
	const path = resolve(options.file)
	let size: number
	try {
		size = (await stat(path)).size
	} catch {
		throw new DataTransferError(`${path} doesn't exist. Make a bundle with \`kora export\` first.`)
	}
	const link = await readProjectLink(options.projectRoot)
	if (!link) {
		throw new DataTransferError(
			"This folder isn't linked to a Kora Cloud project. Deploy it once with `kora deploy --platform kora-cloud`: the import runs beside its production environment.",
		)
	}
	const client = options.client ?? (await signedInClient())

	logger.step('Asking Kora Cloud for an upload link')
	const started = await client.startImport(link.projectId, {
		acceptUnverified: options.acceptUnverified,
	})
	let backup = started
	for (let waited = 0; !backup.upload; waited += pollMs) {
		if (backup.status === 'failed')
			throw new DataTransferError(
				`Kora Cloud couldn't start the import: ${backup.failure ?? 'unknown reason'}`,
			)
		if (waited > 10 * 60_000)
			throw new DataTransferError(
				"Kora Cloud didn't produce an upload link in 10 minutes. Try again later.",
			)
		await sleep(pollMs)
		backup =
			(await client.backups(link.projectId)).find((entry) => entry.id === started.id) ?? backup
	}
	const upload = backup.upload
	if (upload.method !== 'azure-block-blob')
		throw new DataTransferError(
			`This CLI can't upload with "${upload.method}". Update the Kora CLI.`,
		)

	logger.step(
		`Uploading ${formatBytes(size)} (the link expires ${new Date(upload.expiresAt).toLocaleTimeString()})`,
	)
	await uploadBlocks(path, size, upload.url, {
		fetchImpl: options.fetchImpl ?? fetch,
		sleep,
		blockBytes: options.blockBytes ?? BLOCK_BYTES,
		logger,
	})

	logger.step(
		'Uploaded. Kora Cloud is checking it: restoring the database into a scratch copy and checking every file',
	)
	for (;;) {
		await sleep(pollMs * 3)
		const current = (await client.backups(link.projectId)).find((entry) => entry.id === started.id)
		if (!current) throw new DataTransferError('The import disappeared from the project.')
		if (current.status === 'verified') return current
		if (current.status === 'failed' || current.status === 'expired') {
			throw new DataTransferError(
				`The import was refused: ${current.failure ?? current.report?.checks.find((check) => !check.ok)?.detail ?? 'unknown reason'}`,
			)
		}
	}
}

async function signedInClient(): Promise<KoraCloudClient> {
	const credentials = await readCredentials()
	if (!credentials) throw new KoraCloudSignInRequiredError()
	return new KoraCloudClient(credentials.apiUrl, credentials.token)
}

/**
 * Sends the file as staged blocks, then commits the list, so the file appears whole only once
 * it is all there. Each block is retried on its own; a block id is the same on a retry, so a
 * repeated send replaces rather than duplicates.
 */
async function uploadBlocks(
	path: string,
	size: number,
	url: string,
	options: {
		fetchImpl: typeof fetch
		sleep: (milliseconds: number) => Promise<void>
		blockBytes: number
		logger: Logger
	},
): Promise<void> {
	const handle = await open(path, 'r')
	const ids: string[] = []
	let lastShown = 0
	try {
		for (let offset = 0; offset < size; offset += options.blockBytes) {
			const length = Math.min(options.blockBytes, size - offset)
			const body = new Uint8Array(length)
			await handle.read(body, 0, length, offset)
			const id = Buffer.from(`block-${String(ids.length).padStart(8, '0')}`).toString('base64')
			await send(options, `${url}&comp=block&blockid=${encodeURIComponent(id)}`, { body }, 201)
			ids.push(id)
			const percent = Math.floor(((offset + length) / size) * 100)
			if (percent >= lastShown + 10 || offset + length === size) {
				lastShown = percent
				options.logger.step(`  ${percent}% (${formatBytes(offset + length)})`)
			}
		}
	} finally {
		await handle.close()
	}
	const list = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`
	await send(
		options,
		`${url}&comp=blocklist`,
		{
			body: list,
			headers: { 'content-type': 'application/xml', 'x-ms-blob-content-type': 'application/x-tar' },
		},
		201,
	)
}

async function send(
	options: { fetchImpl: typeof fetch; sleep: (milliseconds: number) => Promise<void> },
	url: string,
	init: { body: Uint8Array<ArrayBuffer> | string; headers?: Record<string, string> },
	expected: number,
): Promise<void> {
	for (let attempt = 1; ; attempt += 1) {
		let status = 0
		try {
			const response = await options.fetchImpl(url, {
				method: 'PUT',
				headers: { 'x-ms-version': '2022-11-02', ...init.headers },
				body: init.body,
			})
			status = response.status
			await response.arrayBuffer().catch(() => undefined)
			if (status === expected) return
		} catch {
			// A dropped connection is retried like a server error.
		}
		if (status === 403)
			throw new DataTransferError(
				'The upload link was refused: it has expired or was replaced. Run the import again.',
			)
		if ((status !== 0 && status !== 429 && status < 500) || attempt >= ATTEMPTS) {
			throw new DataTransferError(
				`The upload failed (${status || 'no response'}). Run the import again.`,
			)
		}
		await options.sleep(attempt * 2000)
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export interface LocalImportOptions {
	file: string
	/** The PostgreSQL database to fill. It must be empty. */
	databaseUrl: string
	/** Where the app keeps its files (`KORA_BLOB_DIR`), or null for a bundle without files. */
	blobDir: string | null
	/** Folder holding pg_restore and psql, or null to find them on PATH. */
	pgBin?: string | null | undefined
	logger?: Logger | undefined
}

export interface LocalImportResult {
	tables: number
	rows: number | null
	files: number
	/** Tables whose row count differs from what the bundle recorded (empty when it matched or recorded none). */
	differences: string[]
}

const FILE_ENTRY = /^files\/([a-f0-9]{2})\/([a-f0-9]{64})$/
const IGNORED_ENTRY = /^(README\.txt|README\.md)$|(^|\/)\._|(^|\/)\.DS_Store$/

/**
 * Loads a bundle (`kora export`, or a backup downloaded from Kora Cloud) into your own
 * PostgreSQL database and files folder: everything is read and checked first (the dump against
 * its checksum, each file against its name), the database must be empty, the dump is restored
 * in one transaction, row counts are compared with the bundle's, and files go in last.
 */
export async function runLocalImport(options: LocalImportOptions): Promise<LocalImportResult> {
	const logger = options.logger ?? createLogger()
	const path = resolve(options.file)
	try {
		await access(path)
	} catch {
		throw new DataTransferError(`${path} doesn't exist.`)
	}
	const work = await mkdtemp(join(tmpdir(), 'kora-import-'))
	try {
		logger.step('Reading and checking the bundle')
		const dumpPath = join(work, 'database.dump')
		const staged = join(work, 'files')
		let dump: { sha256: string; bytes: number } | null = null
		let manifest: { database?: { sha256?: unknown; tables?: unknown } } | null = null
		const files: string[] = []
		for await (const entry of readTar(createReadStream(path) as AsyncIterable<Uint8Array>)) {
			if (entry.kind === 'directory' || IGNORED_ENTRY.test(entry.name)) continue
			if (entry.name === 'database.dump' && entry.kind === 'file') {
				dump = await writeHashed(entry.body, dumpPath)
				continue
			}
			if (entry.name === 'manifest.json' && entry.kind === 'file') {
				const chunks: Uint8Array[] = []
				for await (const chunk of entry.body) chunks.push(chunk)
				try {
					manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'))
				} catch {
					throw new DataTransferError("The bundle's manifest.json isn't valid JSON.")
				}
				continue
			}
			const match = FILE_ENTRY.exec(entry.name)
			if (match && entry.kind === 'file' && match[1] === match[2]?.slice(0, 2)) {
				const hash = match[2] ?? ''
				await mkdir(join(staged, match[1] ?? ''), { recursive: true })
				const written = await writeHashed(entry.body, join(staged, match[1] ?? '', hash))
				if (written.sha256 !== hash) {
					throw new DataTransferError(
						`files/${match[1]}/${hash.slice(0, 12)}… doesn't match its name: the bundle is damaged.`,
					)
				}
				files.push(hash)
				continue
			}
			throw new DataTransferError(
				`The bundle holds "${entry.name.slice(0, 120)}", which a Kora bundle doesn't (database.dump, files/, manifest.json).`,
			)
		}
		if (!dump) throw new DataTransferError('The bundle has no database.dump.')
		if (
			typeof manifest?.database?.sha256 === 'string' &&
			manifest.database.sha256 !== dump.sha256
		) {
			throw new DataTransferError(
				"The bundle's database.dump doesn't match the checksum in its manifest: it is damaged.",
			)
		}
		if (files.length > 0 && !options.blobDir) {
			throw new DataTransferError(
				`The bundle holds ${files.length} files. Say where the app keeps them: set KORA_BLOB_DIR or pass --blob-dir.`,
			)
		}

		const psql = postgresTool(options.pgBin ?? null, 'psql')
		const tablesBefore = await sql(
			psql,
			options.databaseUrl,
			"select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')",
		)
		if (tablesBefore.trim() !== '0') {
			throw new DataTransferError(
				'The database already holds tables, so nothing was restored. Point --database-url (or DATABASE_URL) at an empty database.',
			)
		}
		logger.step(`Restoring the ${formatBytes(dump.bytes)} database`)
		const pgRestore = postgresTool(options.pgBin ?? null, 'pg_restore')
		const toolMajor = majorVersion(await run(pgRestore, ['--version'], options.databaseUrl))
		const serverMajor = Math.floor(
			Number((await sql(psql, options.databaseUrl, 'show server_version_num')).trim()) / 10000,
		)
		if (toolMajor !== null && toolMajor > serverMajor) {
			// A newer pg_restore opens every restore with settings an older server doesn't have
			// (pg_restore 17 sets transaction_timeout, which PostgreSQL 16 refuses), so the restore
			// would fail on its first line. Restore through psql instead, leaving out only those
			// header settings. The data and schema statements are passed through untouched.
			const known = new Set(
				(await sql(psql, options.databaseUrl, 'select name from pg_settings'))
					.split('\n')
					.map((name) => name.trim().toLowerCase())
					.filter(Boolean),
			)
			await restoreThroughPsql(pgRestore, psql, dumpPath, options.databaseUrl, known)
		} else {
			await run(
				pgRestore,
				[
					'--no-owner',
					'--no-privileges',
					'--single-transaction',
					'--exit-on-error',
					`--dbname=${withoutPassword(options.databaseUrl)}`,
					dumpPath,
				],
				options.databaseUrl,
			)
		}

		const expected = recordedTables(manifest)
		const counts = await rowCounts(psql, options.databaseUrl)
		const differences = expected
			? [...new Set([...Object.keys(expected), ...Object.keys(counts)])]
					.sort()
					.filter((table) => expected[table] !== counts[table])
					.map((table) => `${table}: ${expected[table] ?? 'absent'} → ${counts[table] ?? 'absent'}`)
			: []

		if (files.length > 0 && options.blobDir) {
			logger.step(`Copying ${files.length} files into ${options.blobDir}`)
			for (const prefix of await readdir(staged)) {
				await mkdir(join(options.blobDir, prefix), { recursive: true })
				for (const name of await readdir(join(staged, prefix))) {
					// Content-addressed: a file already there is the same file.
					const target = join(options.blobDir, prefix, name)
					if (!(await exists(target)))
						await rename(join(staged, prefix, name), target).catch(async () =>
							copyFile(join(staged, prefix, name), target),
						)
				}
			}
		}
		return {
			tables: Object.keys(counts).length,
			rows: Object.values(counts).reduce((sum, value) => sum + value, 0),
			files: files.length,
			differences,
		}
	} finally {
		await rm(work, { recursive: true, force: true })
	}
}

async function writeHashed(
	body: AsyncIterable<Uint8Array>,
	target: string,
): Promise<{ sha256: string; bytes: number }> {
	const hash = createHash('sha256')
	const out = createWriteStream(target)
	let bytes = 0
	for await (const chunk of body) {
		hash.update(chunk)
		bytes += chunk.byteLength
		if (!out.write(chunk))
			await new Promise<void>((resolveDrain) => out.once('drain', resolveDrain))
	}
	await new Promise<void>((resolveEnd, reject) =>
		out.end((error?: Error | null) => (error ? reject(error) : resolveEnd())),
	)
	return { sha256: hash.digest('hex'), bytes }
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

async function copyFile(from: string, to: string): Promise<void> {
	const { copyFile: copy } = await import('node:fs/promises')
	await copy(from, to)
}

function recordedTables(
	manifest: { database?: { tables?: unknown } } | null,
): Record<string, number> | null {
	const tables = manifest?.database?.tables
	if (typeof tables !== 'object' || tables === null || Array.isArray(tables)) return null
	const out: Record<string, number> = {}
	for (const [name, count] of Object.entries(tables))
		if (typeof count === 'number') out[name] = count
	return Object.keys(out).length > 0 ? out : null
}

/** The major version from a PostgreSQL tool's `--version` line, or null when it can't be read. */
export function majorVersion(versionLine: string): number | null {
	const match = /\(PostgreSQL\)\s+(\d+)/.exec(versionLine)
	return match ? Number(match[1]) : null
}

const HEADER_SETTING = /^SET\s+([a-z_][a-z0-9_.]*)\s*=/i
const HEADER_LINE = /^(SET\s|SELECT pg_catalog\.set_config\(|BEGIN;|--|\s*$)/

/**
 * Returns a line filter for a pg_restore script that drops the `SET name = ...;` lines the
 * target server doesn't know, but only in the script's opening block of session settings.
 * Everything from the first statement that isn't a setting on (schema, data, COPY rows) is
 * passed through unchanged, so a row that happens to read like a SET is never touched.
 */
export function createHeaderSettingFilter(known: ReadonlySet<string>): (line: string) => boolean {
	let inHeader = true
	return (line) => {
		if (!inHeader) return true
		if (!HEADER_LINE.test(line)) {
			inHeader = false
			return true
		}
		const setting = HEADER_SETTING.exec(line)?.[1]?.toLowerCase()
		return !setting || setting.includes('.') || known.has(setting)
	}
}

/**
 * Restores with pg_restore writing a script and psql running it in one transaction, stopping at
 * the first error, as `pg_restore --single-transaction --exit-on-error` does.
 */
async function restoreThroughPsql(
	pgRestore: string,
	psql: string,
	dumpPath: string,
	databaseUrl: string,
	known: ReadonlySet<string>,
): Promise<void> {
	const url = new URL(databaseUrl)
	const env = {
		...process.env,
		PGPASSWORD: decodeURIComponent(url.password),
		PGCONNECT_TIMEOUT: '30',
	}
	const producer = spawn(
		pgRestore,
		['--no-owner', '--no-privileges', '--single-transaction', '--file=-', dumpPath],
		{ env, stdio: ['ignore', 'pipe', 'pipe'] },
	)
	const consumer = spawn(
		psql,
		[
			'--no-psqlrc',
			'--quiet',
			'--set=ON_ERROR_STOP=1',
			`--dbname=${withoutPassword(databaseUrl)}`,
			'--file=-',
		],
		{ env, stdio: ['pipe', 'ignore', 'pipe'] },
	)
	const stderrOf = (child: typeof producer | typeof consumer): (() => string) => {
		let text = ''
		child.stderr?.on('data', (chunk: Buffer) => {
			if (text.length < 8192) text += chunk.toString('utf8')
		})
		return () => text
	}
	const producerErrors = stderrOf(producer)
	const consumerErrors = stderrOf(consumer)
	const exited = (child: typeof producer | typeof consumer): Promise<number | null> =>
		new Promise((resolveExit, reject) => {
			child.on('error', reject)
			child.on('close', (code) => resolveExit(code))
		})
	const producerExit = exited(producer)
	const consumerExit = exited(consumer)

	const keep = createHeaderSettingFilter(known)
	let pendingText = ''
	const write = async (text: string): Promise<void> => {
		if (consumer.exitCode !== null) throw new Error('psql stopped')
		if (consumer.stdin && !consumer.stdin.write(text))
			await Promise.race([
				new Promise<void>((resolveDrain) => consumer.stdin?.once('drain', resolveDrain)),
				consumerExit,
			])
	}
	// A broken pipe once psql has stopped is reported through psql's own exit, not thrown here.
	consumer.stdin?.on('error', () => undefined)
	try {
		for await (const chunk of producer.stdout as AsyncIterable<Buffer>) {
			pendingText += chunk.toString('utf8')
			const lines = pendingText.split('\n')
			pendingText = lines.pop() ?? ''
			const out = lines
				.filter((line) => keep(line))
				.map((line) => `${line}\n`)
				.join('')
			if (out) await write(out)
		}
		if (pendingText && keep(pendingText)) await write(pendingText)
	} catch {
		// psql stopped reading (it failed); its exit code and message say why.
		producer.kill('SIGTERM')
	}
	consumer.stdin?.end()
	const [producerCode, consumerCode] = await Promise.all([producerExit, consumerExit])
	const failure = (tool: string, stderr: string): DataTransferError => {
		const line =
			stderr
				.split('\n')
				.find((entry) => /error/i.test(entry))
				?.trim() ??
			stderr.trim().split('\n')[0] ??
			''
		return new DataTransferError(
			`${tool} failed: ${line.replace(/postgres(?:ql)?:\/\/\S+/gi, '<database>').slice(0, 300)}`,
		)
	}
	if (consumerCode !== 0) throw failure('psql', consumerErrors())
	if (producerCode !== 0) throw failure('pg_restore', producerErrors())
}

function postgresTool(pgBin: string | null, name: 'psql' | 'pg_restore'): string {
	return pgBin ? join(pgBin, name) : name
}

function withoutPassword(databaseUrl: string): string {
	const url = new URL(databaseUrl)
	url.password = ''
	return url.toString()
}

/** Runs a PostgreSQL tool with the password in the environment, never on the command line. */
async function run(command: string, args: string[], databaseUrl: string): Promise<string> {
	let url: URL
	try {
		url = new URL(databaseUrl)
	} catch {
		throw new DataTransferError('The database address is not a valid postgresql:// URL.')
	}
	return await new Promise<string>((resolveRun, reject) => {
		const child = spawn(command, args, {
			env: {
				...process.env,
				PGPASSWORD: decodeURIComponent(url.password),
				PGCONNECT_TIMEOUT: '30',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8')
		})
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderr.length < 8192) stderr += chunk.toString('utf8')
		})
		child.on('error', (error) => {
			reject(
				(error as NodeJS.ErrnoException).code === 'ENOENT'
					? new DataTransferError(
							`${command} wasn't found. Install PostgreSQL's client tools (the same major version as the database server or newer), or point --pg-bin at them.`,
						)
					: error,
			)
		})
		child.on('close', (code) => {
			if (code === 0) return resolveRun(stdout)
			const line =
				stderr
					.split('\n')
					.find((entry) => /error/i.test(entry))
					?.trim() ??
				stderr.trim().split('\n')[0] ??
				''
			reject(
				new DataTransferError(
					`${command.split('/').at(-1)} failed: ${line.replace(/postgres(?:ql)?:\/\/\S+/gi, '<database>').slice(0, 300)}`,
				),
			)
		})
	})
}

async function sql(psql: string, databaseUrl: string, query: string): Promise<string> {
	return await run(
		psql,
		[
			'--no-psqlrc',
			'--tuples-only',
			'--no-align',
			`--dbname=${withoutPassword(databaseUrl)}`,
			'--command',
			query,
		],
		databaseUrl,
	)
}

/** Row counts per table, keyed `schema.table` as Kora Cloud's manifests record them. */
async function rowCounts(psql: string, databaseUrl: string): Promise<Record<string, number>> {
	const tables = (
		await sql(
			psql,
			databaseUrl,
			"select schemaname || '.' || tablename from pg_tables where schemaname not in ('pg_catalog', 'information_schema') order by 1",
		)
	)
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
	const counts: Record<string, number> = {}
	for (const table of tables) {
		const [schema, name] = table.split('.')
		const quoted = `"${(schema ?? '').replaceAll('"', '""')}"."${(name ?? '').replaceAll('"', '""')}"`
		counts[table] = Number((await sql(psql, databaseUrl, `select count(*) from ${quoted}`)).trim())
	}
	return counts
}

export const importCommand = defineCommand({
	meta: {
		name: 'import',
		description:
			"Bring an app's data (a `kora export` bundle or a downloaded backup) into Kora Cloud",
	},
	args: {
		file: {
			type: 'positional',
			description: 'The bundle to import',
			required: true,
		},
		platform: {
			type: 'string',
			description:
				'Import into Kora Cloud (kora-cloud). Leave out to load it into your own database',
		},
		'database-url': {
			type: 'string',
			description:
				'Without --platform: the empty PostgreSQL database to fill (default: DATABASE_URL)',
		},
		'blob-dir': {
			type: 'string',
			description: 'Without --platform: where the app keeps its files (default: KORA_BLOB_DIR)',
		},
		'pg-bin': {
			type: 'string',
			description: 'Folder holding pg_restore and psql, when they are not on PATH',
		},
		'accept-unverified': {
			type: 'string',
			description:
				"With --platform: accept exactly this many operations the app's own tools wrote around the server's checks (the count a refused import reported)",
		},
	},
	async run({ args }) {
		const logger = createLogger()
		if (args.platform !== undefined && args.platform !== 'kora-cloud') {
			throw new DataTransferError(
				`Unknown --platform "${args.platform}". Use kora-cloud, or leave it out to load the bundle into your own database.`,
			)
		}
		const acceptUnverified = parseAcceptUnverified(args['accept-unverified'])
		if (args.platform !== 'kora-cloud' && acceptUnverified !== undefined) {
			throw new DataTransferError(
				'--accept-unverified applies to an import into Kora Cloud (--platform kora-cloud).',
			)
		}
		if (args.platform !== 'kora-cloud') {
			const databaseUrl =
				typeof args['database-url'] === 'string' ? args['database-url'] : process.env.DATABASE_URL
			if (!databaseUrl)
				throw new DataTransferError(
					'Say which database to fill: set DATABASE_URL or pass --database-url (an empty PostgreSQL database).',
				)
			logger.banner()
			const result = await runLocalImport({
				file: String(args.file),
				databaseUrl,
				blobDir:
					typeof args['blob-dir'] === 'string'
						? args['blob-dir']
						: (process.env.KORA_BLOB_DIR ?? null),
				pgBin: typeof args['pg-bin'] === 'string' ? args['pg-bin'] : null,
				logger,
			})
			if (result.differences.length > 0) {
				throw new DataTransferError(
					`Restored, but row counts differ from the bundle's: ${result.differences.slice(0, 5).join('; ')}. Don't use this copy; restore again into an empty database.`,
				)
			}
			logger.success(
				`Restored ${result.tables} tables (${result.rows} rows) and ${result.files} files`,
			)
			logger.step(
				'Start the app with this DATABASE_URL and KORA_BLOB_DIR, and point its devices at it (VITE_SYNC_URL).',
			)
			return
		}
		logger.banner()
		const backup = await runCloudImport({
			file: String(args.file),
			projectRoot: process.cwd(),
			logger,
			acceptUnverified,
		})
		const report = backup.report
		logger.success('Imported and verified')
		if (report?.database)
			logger.step(`Database: ${report.database.tables} tables, ${report.database.rows} rows`)
		if (report?.kora)
			logger.step(
				backup.acceptUnverified
					? `Kora operations: ${report.kora.operations}, ${backup.acceptUnverified} of them accepted as written by the app's own tools; any later change to those is still caught`
					: `Kora operations: ${report.kora.operations}, each matching its content hash`,
			)
		if (report?.files)
			logger.step(`Files: ${report.files.count} (${formatBytes(report.files.bytes)})`)
		logger.blank()
		logger.info(
			"The app's live data is unchanged. To use the imported data, open the project's Backups page in the console:",
		)
		logger.step(
			'"Replace production\'s data" loads it into production; "Restore to a new environment" opens a copy to try first.',
		)
	},
})
