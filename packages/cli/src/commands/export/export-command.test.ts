import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DataTransferError } from '../../errors'
import type { Logger } from '../../utils/logger'
import { runExport } from './export-command'

const quiet: Logger = {
	info: () => undefined,
	success: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	step: () => undefined,
	blank: () => undefined,
	banner: () => undefined,
}
const PG_URL = process.env.KORA_PG_TEST_URL
const PG_BIN =
	['/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin'].find((dir) =>
		existsSync(join(dir, 'pg_dump')),
	) ?? null

async function filesFolder(contents: string[]): Promise<{ dir: string; hashes: string[] }> {
	const dir = await mkdtemp(join(tmpdir(), 'kora-blobs-'))
	const hashes: string[] = []
	for (const content of contents) {
		const hash = createHash('sha256').update(content).digest('hex')
		await mkdir(join(dir, hash.slice(0, 2)), { recursive: true })
		await writeFile(join(dir, hash.slice(0, 2), hash), content)
		hashes.push(hash)
	}
	// Not the app's data: left out.
	await writeFile(join(dir, 'notes.txt'), 'not a Kora file')
	return { dir, hashes }
}

test('a missing pg_dump is explained, with what to install', async () => {
	const empty = await mkdtemp(join(tmpdir(), 'kora-nobin-'))
	await expect(
		runExport({
			databaseUrl: 'postgresql://u:p@127.0.0.1:1/db',
			blobDir: null,
			out: join(empty, 'x.tar'),
			pgBin: empty,
			logger: quiet,
		}),
	).rejects.toThrow(/pg_dump wasn't found/)
	expect(existsSync(join(empty, 'x.tar'))).toBe(false)
})

test('only PostgreSQL addresses are exported', async () => {
	await expect(
		runExport({
			databaseUrl: 'file:./app.db',
			blobDir: null,
			out: '/tmp/never.tar',
			logger: quiet,
		}),
	).rejects.toBeInstanceOf(DataTransferError)
})

describe.skipIf(!PG_URL || !PG_BIN)('postgres: export', () => {
	test("bundles the whole database and the app's files, which restore with the standard tools", async () => {
		execFileSync(join(PG_BIN!, 'psql'), [
			PG_URL!,
			'-q',
			'-c',
			'drop table if exists export_probe; create table export_probe (id int); insert into export_probe select generate_series(1, 25)',
		])
		const { dir, hashes } = await filesFolder(['first file', 'second file'])
		const work = await mkdtemp(join(tmpdir(), 'kora-export-test-'))
		const out = join(work, 'app.tar')
		const result = await runExport({
			databaseUrl: PG_URL!,
			blobDir: dir,
			out,
			pgBin: PG_BIN,
			logger: quiet,
		})
		expect(result.files).toBe(2)
		const listed = execFileSync('tar', ['-tf', out], { encoding: 'utf8' }).trim().split('\n')
		expect(listed).toEqual([
			'README.txt',
			'database.dump',
			...hashes
				.slice()
				.sort()
				.map((hash) => `files/${hash.slice(0, 2)}/${hash}`),
			'manifest.json',
		])
		execFileSync('tar', ['-xf', out, '-C', work])
		const manifest = JSON.parse(await readFile(join(work, 'manifest.json'), 'utf8'))
		expect(manifest.files).toHaveLength(2)
		expect(manifest.database.sha256).toBe(
			createHash('sha256')
				.update(await readFile(join(work, 'database.dump')))
				.digest('hex'),
		)
		const contents = execFileSync(
			join(PG_BIN!, 'pg_restore'),
			['--list', join(work, 'database.dump')],
			{ encoding: 'utf8' },
		)
		expect(contents).toMatch(/TABLE DATA public export_probe/)
	})

	test('a damaged file stops the export and leaves no half-written bundle', async () => {
		const { dir, hashes } = await filesFolder(['will be damaged'])
		await writeFile(join(dir, hashes[0]!.slice(0, 2), hashes[0]!), "changed behind Kora's back")
		const out = join(await mkdtemp(join(tmpdir(), 'kora-export-bad-')), 'app.tar')
		await expect(
			runExport({ databaseUrl: PG_URL!, blobDir: dir, out, pgBin: PG_BIN, logger: quiet }),
		).rejects.toThrow(/doesn't match its name/)
		expect(existsSync(out)).toBe(false)
	})
})
