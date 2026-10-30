import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import {
	doctorHasFailures,
	formatDoctorJson,
	isDatabaseCheck,
	runDoctorChecks,
	toSyncStatusHttpBase,
} from './doctor-checks'

describe('doctor checks', () => {
	const temps: Array<{ cleanup: () => Promise<void> }> = []

	afterEach(async () => {
		for (const temp of temps) {
			await temp.cleanup()
		}
		temps.length = 0
	})

	it('doctorHasFailures is true when a check failed', () => {
		expect(
			doctorHasFailures([
				{ id: 'a', title: 'A', status: 'pass', message: 'ok' },
				{ id: 'b', title: 'B', status: 'fail', message: 'bad' },
			]),
		).toBe(true)
	})

	it('strict fails on warnings, limited to database checks when asked', () => {
		const results = [
			{ id: 'worker', title: 'W', status: 'warn' as const, message: 'no worker' },
			{ id: 'db-schema-drift', title: 'D', status: 'pass' as const, message: 'ok' },
		]
		expect(doctorHasFailures(results)).toBe(false)
		expect(doctorHasFailures(results, true)).toBe(true)
		expect(doctorHasFailures(results, true, isDatabaseCheck)).toBe(false)
		const dbWarn = [
			...results,
			{ id: 'db-json-strings', title: 'J', status: 'warn' as const, message: 'x' },
		]
		expect(doctorHasFailures(dbWarn, true, isDatabaseCheck)).toBe(true)
	})

	it('converts ws sync URL to http base for status probe', () => {
		expect(toSyncStatusHttpBase('ws://localhost:3001/kora-sync')).toBe('http://localhost:3001')
		expect(toSyncStatusHttpBase('wss://sync.example.com/kora')).toBe('https://sync.example.com')
	})

	it('reports missing schema as failure', async () => {
		const temp = await createTempDir()
		temps.push(temp)
		await writeFile(
			join(temp.path, 'package.json'),
			JSON.stringify({ name: 'test-app', dependencies: { korajs: '0.4.0' } }),
		)

		const results = await runDoctorChecks({ projectRoot: temp.path, skipNetwork: true })
		const schema = results.find((r) => r.id === 'schema')
		expect(schema?.status).toBe('fail')
		expect(doctorHasFailures(results)).toBe(true)
	})

	it('passes worker check when kora-worker.ts exists', async () => {
		const temp = await createTempDir()
		temps.push(temp)
		await mkdir(join(temp.path, 'src'), { recursive: true })
		await writeFile(
			join(temp.path, 'package.json'),
			JSON.stringify({ name: 'test-app', dependencies: { korajs: '0.4.0' } }),
		)
		await writeFile(join(temp.path, 'src', 'kora-worker.ts'), 'export {}')
		await writeFile(
			join(temp.path, 'src', 'schema.js'),
			`export default {
  version: 1,
  collections: { todos: { fields: { title: { kind: 'string' } } } },
  relations: {},
}`,
		)

		const results = await runDoctorChecks({ projectRoot: temp.path, skipNetwork: true })
		const worker = results.find((r) => r.id === 'worker')
		expect(worker?.status).toBe('pass')
	})

	it('fails when canary packages come from different releases', async () => {
		const temp = await createTempDir()
		temps.push(temp)
		await mkdir(join(temp.path, 'src'), { recursive: true })
		await writeFile(
			join(temp.path, 'package.json'),
			JSON.stringify({
				name: 'test-app',
				dependencies: {
					korajs: '0.0.0-canary-20261018000000',
					'@korajs/react': '0.0.0-canary-20261019000000',
				},
			}),
		)
		await writeFile(
			join(temp.path, 'src', 'schema.js'),
			'export default { version: 1, collections: {}, relations: {} }',
		)

		const results = await runDoctorChecks({ projectRoot: temp.path, skipNetwork: true })
		expect(results.find((result) => result.id === 'package-versions')).toMatchObject({
			status: 'fail',
		})
	})

	it('audits production auth and access boundaries only when requested', async () => {
		const temp = await createTempDir()
		temps.push(temp)
		await mkdir(join(temp.path, 'src'), { recursive: true })
		await writeFile(
			join(temp.path, 'package.json'),
			JSON.stringify({ name: 'test-app', dependencies: { korajs: '1.0.0-beta.14' } }),
		)
		await writeFile(
			join(temp.path, 'src', 'schema.js'),
			'export default { version: 1, collections: {}, relations: {} }',
		)

		const normal = await runDoctorChecks({ projectRoot: temp.path, skipNetwork: true })
		expect(normal.some((result) => result.id.startsWith('production-'))).toBe(false)

		const production = await runDoctorChecks({
			projectRoot: temp.path,
			skipNetwork: true,
			production: true,
		})
		expect(production.find((result) => result.id === 'production-access')).toMatchObject({
			status: 'warn',
		})
		expect(production.find((result) => result.id === 'production-auth')).toMatchObject({
			status: 'warn',
		})
	})
	it('adds the static production audit and the schema-duplicates check', async () => {
		const temp = await createTempDir()
		temps.push(temp)
		await mkdir(join(temp.path, 'src'), { recursive: true })
		await writeFile(
			join(temp.path, 'package.json'),
			JSON.stringify({ name: 'test-app', dependencies: { korajs: '1.0.0-beta.14' } }),
		)
		await writeFile(
			join(temp.path, 'src', 'schema.js'),
			'export default { version: 1, collections: {}, relations: {} }',
		)
		const results = await runDoctorChecks({
			projectRoot: temp.path,
			skipNetwork: true,
			production: true,
		})
		const ids = results.map((r) => r.id)
		expect(ids).toContain('schema-duplicates')
		expect(ids).toContain('production-worker-delivery')
		expect(ids).toContain('production-isolation-headers')
		expect(ids).toContain('production-runtime-storage')
		// no build output in the fixture: a skip, not an error
		expect(results.find((r) => r.id === 'production-worker-delivery')?.status).toBe('skip')
		// the deployed-server probe needs --url
		expect(ids.some((id) => id.startsWith('production-server-'))).toBe(false)
	})

	it('probes the deployed server with --production --url, in place of the dev status probe', async () => {
		const temp = await createTempDir()
		temps.push(temp)
		await mkdir(join(temp.path, 'src'), { recursive: true })
		await writeFile(
			join(temp.path, 'package.json'),
			JSON.stringify({ name: 'test-app', dependencies: { korajs: '1.0.0-beta.14' } }),
		)
		await writeFile(
			join(temp.path, 'src', 'schema.js'),
			'export default { version: 1, collections: {}, relations: {} }',
		)
		const requested: string[] = []
		const probe = {
			fetch: async (input: RequestInfo | URL) => {
				requested.push(String(input))
				throw new TypeError('offline')
			},
			timeoutSignal: () => new AbortController().signal,
			fs: { readText: async () => null, walk: async () => null },
		}
		const results = await runDoctorChecks({
			projectRoot: temp.path,
			production: true,
			syncHttpUrl: 'https://sync.example.com',
			seams: { probe },
		})
		expect(requested).toEqual(['https://sync.example.com/health'])
		expect(results.find((r) => r.id === 'production-server-health')).toMatchObject({
			status: 'warn',
		})
		expect(results.some((r) => r.id === 'sync-server')).toBe(false)
		// a failing network never makes the run fail
		expect(doctorHasFailures(results.filter((r) => r.id.startsWith('production-server-')))).toBe(
			false,
		)
	})

	it('skips the deployed-server probe with --skip-network', async () => {
		const temp = await createTempDir()
		temps.push(temp)
		await writeFile(
			join(temp.path, 'package.json'),
			JSON.stringify({ name: 'test-app', dependencies: { korajs: '1.0.0-beta.14' } }),
		)
		const results = await runDoctorChecks({
			projectRoot: temp.path,
			production: true,
			skipNetwork: true,
			syncHttpUrl: 'https://sync.example.com',
		})
		expect(results.find((r) => r.id === 'production-server-health')?.status).toBe('skip')
	})

	it('formatDoctorJson keeps the check objects and reports the verdict', () => {
		const checks = [
			{ id: 'a', title: 'A', status: 'pass' as const, message: 'ok' },
			{ id: 'b', title: 'B', status: 'warn' as const, message: 'hmm', fix: 'do x' },
			{ id: 'c', title: 'C', status: 'skip' as const, message: 'later' },
		]
		const json = formatDoctorJson('/app', checks, false)
		expect(json).toEqual({
			projectRoot: '/app',
			ok: true,
			summary: { pass: 1, warn: 1, fail: 0, skip: 1 },
			checks,
		})
		expect(JSON.parse(JSON.stringify(json))).toEqual(json)
		expect(formatDoctorJson('/app', checks, true).ok).toBe(false)
	})
})
