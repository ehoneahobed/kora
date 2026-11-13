import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type CloudBackup, KoraCloudClient } from '../../cloud/cloud-client'
import type { Logger } from '../../utils/logger'
import { parseAcceptUnverified, runCloudImport } from './import-command'

const quiet: Logger = {
	info: () => undefined,
	success: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	step: () => undefined,
	blank: () => undefined,
	banner: () => undefined,
}
const UPLOAD = 'https://acct.blob.core.windows.net/env-1/imports/bkp_1/bundle.tar?sp=cw&sig=s'

async function linkedProject(bytes: number): Promise<{ root: string; file: string }> {
	const root = await mkdtemp(join(tmpdir(), 'kora-import-'))
	await mkdir(join(root, '.kora'))
	await writeFile(
		join(root, '.kora', 'cloud.json'),
		JSON.stringify({ organizationId: 'org_1', projectId: 'prj_1' }),
	)
	const file = join(root, 'app.tar')
	await writeFile(file, Buffer.alloc(bytes, 7))
	return { root, file }
}

/** Kora Cloud's API and Azure's blob endpoint, as the import sees them. */
function fakeCloud(outcome: { final: Partial<CloudBackup>; refuseBlocks?: number }) {
	const puts: Array<{ url: string; bytes: number; body?: string }> = []
	const starts: unknown[] = []
	let polls = 0
	let uploaded = false
	const backup = (extra: Partial<CloudBackup>): CloudBackup => ({
		id: 'bkp_1',
		status: 'running',
		trigger: 'import',
		failure: null,
		report: null,
		upload: null,
		...extra,
	})
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		if (url.startsWith('https://acct.blob.core.windows.net/')) {
			const body = init?.body
			puts.push({
				url,
				bytes: typeof body === 'string' ? body.length : (body as Uint8Array).byteLength,
				...(typeof body === 'string' ? { body } : {}),
			})
			if (outcome.refuseBlocks && puts.length <= outcome.refuseBlocks)
				return new Response(null, { status: 503 })
			if (url.includes('comp=blocklist')) uploaded = true
			return new Response(null, { status: 201 })
		}
		const path = new URL(url).pathname
		if (path === '/v1/projects/prj_1/backups/import') {
			starts.push(JSON.parse(String(init?.body ?? '{}')))
			return Response.json({ backup: backup({ status: 'queued' }) }, { status: 202 })
		}
		if (path === '/v1/projects/prj_1/backups') {
			polls += 1
			const current = uploaded
				? backup(outcome.final)
				: backup(
						polls >= 2
							? {
									upload: {
										url: UPLOAD,
										expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
										method: 'azure-block-blob',
									},
								}
							: {},
					)
			return Response.json({ backups: [current] })
		}
		return new Response(null, { status: 404 })
	}) as typeof fetch
	return {
		puts,
		starts,
		fetchImpl,
		client: new KoraCloudClient('https://api.example', 'token', fetchImpl),
	}
}

test('an import waits for its link, uploads the file as blocks committed at the end, and reports the verified result', async () => {
	const { root, file } = await linkedProject(10)
	const cloud = fakeCloud({
		final: {
			status: 'verified',
			report: {
				database: { bytes: 10, tables: 3, rows: 9 },
				kora: { operations: 4 },
				files: { count: 0, bytes: 0 },
				checks: [],
			},
		},
		refuseBlocks: 1,
	})
	const result = await runCloudImport({
		file,
		projectRoot: root,
		client: cloud.client,
		fetchImpl: cloud.fetchImpl,
		logger: quiet,
		sleep: async () => undefined,
		pollMs: 1,
		blockBytes: 4,
	})
	expect(result.status).toBe('verified')
	const blocks = cloud.puts.filter((put) => put.url.includes('comp=block&'))
	// The first send was refused once (503) and retried with the same id.
	expect(blocks.map((put) => put.bytes)).toEqual([4, 4, 4, 2])
	const ids = blocks
		.slice(1)
		.map((put) => decodeURIComponent(new URL(put.url).searchParams.get('blockid') ?? ''))
	expect(new Set(ids.map((id) => id.length)).size).toBe(1)
	const commit = cloud.puts.at(-1)!
	expect(commit.url).toBe(`${UPLOAD}&comp=blocklist`)
	expect(commit.body).toBe(
		`<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`,
	)
})

test('an import accepts unverifiable operations only when asked, with the exact count', async () => {
	const { root, file } = await linkedProject(10)
	const verified = {
		status: 'verified' as const,
		report: { database: null, kora: { operations: 4 }, files: null, checks: [] },
	}
	const plain = fakeCloud({ final: verified })
	await runCloudImport({
		file,
		projectRoot: root,
		client: plain.client,
		fetchImpl: plain.fetchImpl,
		logger: quiet,
		sleep: async () => undefined,
		pollMs: 1,
	})
	expect(plain.starts).toEqual([{}])
	const accepting = fakeCloud({ final: verified })
	await runCloudImport({
		file,
		projectRoot: root,
		client: accepting.client,
		fetchImpl: accepting.fetchImpl,
		logger: quiet,
		sleep: async () => undefined,
		pollMs: 1,
		acceptUnverified: 8349,
	})
	expect(accepting.starts).toEqual([{ acceptUnverified: 8349 }])
})

test('--accept-unverified takes a positive whole number', () => {
	expect(parseAcceptUnverified(undefined)).toBeUndefined()
	expect(parseAcceptUnverified('8349')).toBe(8349)
	for (const wrong of ['0', '-2', '1.5', 'all', '', true])
		expect(() => parseAcceptUnverified(wrong)).toThrow(/--accept-unverified/)
})

test('a refused import says why', async () => {
	const { root, file } = await linkedProject(3)
	const cloud = fakeCloud({
		final: { status: 'failed', failure: 'The upload has no database.dump.' },
	})
	await expect(
		runCloudImport({
			file,
			projectRoot: root,
			client: cloud.client,
			fetchImpl: cloud.fetchImpl,
			logger: quiet,
			sleep: async () => undefined,
			pollMs: 1,
		}),
	).rejects.toThrow(/refused: The upload has no database\.dump/)
})

test('a folder not linked to a project is told to deploy first', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kora-unlinked-'))
	await writeFile(join(root, 'a.tar'), 'x')
	await expect(
		runCloudImport({
			file: join(root, 'a.tar'),
			projectRoot: root,
			client: new KoraCloudClient('https://api.example', 't'),
			logger: quiet,
		}),
	).rejects.toThrow(/kora deploy --platform kora-cloud/)
})
