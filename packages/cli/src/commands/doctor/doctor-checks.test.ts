import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDir } from '../../../tests/fixtures/test-helpers'
import { doctorHasFailures, runDoctorChecks, toSyncStatusHttpBase } from './doctor-checks'

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
})
