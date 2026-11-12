import { open, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import { type CloudBackup, KoraCloudClient } from '../../cloud/cloud-client'
import { readCredentials } from '../../cloud/credentials'
import { readProjectLink } from '../../cloud/project-link'
import { DataTransferError, KoraCloudSignInRequiredError } from '../../errors'
import { type Logger, createLogger } from '../../utils/logger'

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
	const started = await client.startImport(link.projectId)
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
			description: 'Where to import it: kora-cloud',
		},
	},
	async run({ args }) {
		const logger = createLogger()
		if (args.platform !== 'kora-cloud') {
			throw new DataTransferError(
				'Say where to import to: `kora import <file> --platform kora-cloud`. To load a bundle into your own database, follow the README inside it (pg_restore, then copy files/).',
			)
		}
		logger.banner()
		const backup = await runCloudImport({
			file: String(args.file),
			projectRoot: process.cwd(),
			logger,
		})
		const report = backup.report
		logger.success('Imported and verified')
		if (report?.database)
			logger.step(`Database: ${report.database.tables} tables, ${report.database.rows} rows`)
		if (report?.kora)
			logger.step(`Kora operations: ${report.kora.operations}, each matching its content hash`)
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
