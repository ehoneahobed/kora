import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import type { Logger } from '../../utils/logger'
import { runExport } from '../export/export-command'
import { createHeaderSettingFilter, majorVersion, runLocalImport } from './import-command'

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
		existsSync(join(dir, 'psql')),
	) ?? null
// Client tools newer than the test server (PostgreSQL 16), when installed.
const NEWER_PG_BIN =
	['/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin'].find((dir) =>
		existsSync(join(dir, 'pg_restore')),
	) ?? null
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
const created: string[] = []

const psql = (url: string, sql: string): string =>
	execFileSync(join(PG_BIN ?? '', 'psql'), ['--no-psqlrc', '-tAq', url, '-c', sql], {
		encoding: 'utf8',
	}).trim()
const urlFor = (database: string): string => {
	const url = new URL(PG_URL ?? 'postgresql://x/y')
	url.pathname = `/${database}`
	return url.toString()
}
async function database(name: string): Promise<string> {
	const full = `kora_import_${name}_${created.length}_${suffix}`
	psql(PG_URL ?? '', `create database ${full}`)
	created.push(full)
	return urlFor(full)
}

afterAll(() => {
	if (!PG_URL) return
	for (const name of created) psql(PG_URL, `drop database if exists ${name} with (force)`)
})

async function sourceBundle(): Promise<{ bundle: string; hashes: string[] }> {
	const source = await database('source')
	psql(
		source,
		"create table notes (id serial primary key, body text); insert into notes (body) select 'note ' || n from generate_series(1, 30) n",
	)
	const blobs = await mkdtemp(join(tmpdir(), 'kora-import-blobs-'))
	const hashes: string[] = []
	for (const content of ['a lesson', 'a certificate']) {
		const hash = createHash('sha256').update(content).digest('hex')
		await mkdir(join(blobs, hash.slice(0, 2)), { recursive: true })
		await writeFile(join(blobs, hash.slice(0, 2), hash), content)
		hashes.push(hash)
	}
	const bundle = join(await mkdtemp(join(tmpdir(), 'kora-import-bundle-')), 'app.tar')
	await runExport({
		databaseUrl: source,
		blobDir: blobs,
		out: bundle,
		pgBin: PG_BIN,
		logger: quiet,
	})
	return { bundle, hashes }
}

describe.skipIf(!PG_URL || !PG_BIN)('postgres: kora import into your own database', () => {
	test('fills an empty database and files folder, and refuses one that holds data', async () => {
		const { bundle, hashes } = await sourceBundle()
		const target = await database('target')
		const blobDir = await mkdtemp(join(tmpdir(), 'kora-import-into-'))
		const result = await runLocalImport({
			file: bundle,
			databaseUrl: target,
			blobDir,
			pgBin: PG_BIN,
			logger: quiet,
		})
		expect(result).toMatchObject({ files: 2, differences: [] })
		expect(psql(target, 'select count(*) from notes')).toBe('30')
		for (const hash of hashes)
			expect(
				createHash('sha256')
					.update(readFileSync(join(blobDir, hash.slice(0, 2), hash)))
					.digest('hex'),
			).toBe(hash)
		await expect(
			runLocalImport({ file: bundle, databaseUrl: target, blobDir, pgBin: PG_BIN, logger: quiet }),
		).rejects.toThrow(/already holds tables/)
	})

	test('a bundle with files needs a folder for them, and a damaged bundle restores nothing', async () => {
		const { bundle } = await sourceBundle()
		await expect(
			runLocalImport({
				file: bundle,
				databaseUrl: await database('nofolder'),
				blobDir: null,
				pgBin: PG_BIN,
				logger: quiet,
			}),
		).rejects.toThrow(/set KORA_BLOB_DIR or pass --blob-dir/)
		const work = await mkdtemp(join(tmpdir(), 'kora-import-damaged-'))
		execFileSync('tar', ['-xf', bundle, '-C', work])
		const [prefix] = execFileSync('ls', [join(work, 'files')], { encoding: 'utf8' })
			.trim()
			.split('\n')
		const [name] = execFileSync('ls', [join(work, 'files', prefix ?? '')], { encoding: 'utf8' })
			.trim()
			.split('\n')
		await writeFile(join(work, 'files', prefix ?? '', name ?? ''), 'changed')
		const damaged = join(work, 'damaged.tar')
		// Repacked the way a person would with the system tar: a leading ./ and directories.
		execFileSync('tar', [
			'-cf',
			damaged,
			'-C',
			work,
			'./README.txt',
			'./database.dump',
			'./files',
			'./manifest.json',
		])
		const target = await database('damaged')
		await expect(
			runLocalImport({
				file: damaged,
				databaseUrl: target,
				blobDir: await mkdtemp(join(tmpdir(), 'x-')),
				pgBin: PG_BIN,
				logger: quiet,
			}),
		).rejects.toThrow(/doesn't match its name/)
		expect(psql(target, "select count(*) from pg_tables where schemaname = 'public'")).toBe('0')
	})
})

describe('restoring with client tools newer than the server', () => {
	test('reads the major version from a tool', () => {
		expect(majorVersion('pg_restore (PostgreSQL) 17.5 (Homebrew)')).toBe(17)
		expect(majorVersion('pg_restore (PostgreSQL) 16.4')).toBe(16)
		expect(majorVersion('something else')).toBeNull()
	})

	test('drops only header settings the server lacks, and never touches what follows', () => {
		const keep = createHeaderSettingFilter(new Set(['statement_timeout', 'client_encoding']))
		const script = [
			'--',
			'-- PostgreSQL database dump',
			'BEGIN;',
			'SET statement_timeout = 0;',
			'SET transaction_timeout = 0;',
			"SET client_encoding = 'UTF8';",
			"SELECT pg_catalog.set_config('search_path', '', false);",
			"SET my.custom = 'x';",
			'',
			'CREATE TABLE public.notes (body text);',
			'COPY public.notes (body) FROM stdin;',
			'SET transaction_timeout = 0;',
			'\\.',
		]
		expect(script.filter((line) => keep(line))).toEqual(script.filter((_, index) => index !== 4))
	})
})

describe.skipIf(!PG_URL || !PG_BIN || !NEWER_PG_BIN)(
	'postgres: kora import with client tools newer than the server',
	() => {
		test('restores a bundle the newer tools wrote, leaving data that reads like a setting intact', async () => {
			const source = await database('newer_source')
			psql(
				source,
				"create table notes (id serial primary key, body text); insert into notes (body) values ('SET transaction_timeout = 0;'), ('an ordinary note')",
			)
			const bundle = join(await mkdtemp(join(tmpdir(), 'kora-import-newer-')), 'app.tar')
			await runExport({
				databaseUrl: source,
				blobDir: null,
				out: bundle,
				pgBin: NEWER_PG_BIN,
				logger: quiet,
			})
			const target = await database('newer_target')
			const result = await runLocalImport({
				file: bundle,
				databaseUrl: target,
				blobDir: null,
				pgBin: NEWER_PG_BIN,
				logger: quiet,
			})
			expect(result.differences).toEqual([])
			expect(psql(target, 'select body from notes order by id')).toBe(
				'SET transaction_timeout = 0;\nan ordinary note',
			)
		})
	},
)
