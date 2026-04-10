import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
	type RailwayJsonOptions,
	generateRailwayJson,
	writeRailwayJsonArtifact,
} from './railway-json-generator'

describe('railway-json-generator', () => {
	const tempDirectories: string[] = []

	afterEach(async () => {
		for (const directory of tempDirectories.splice(0)) {
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('generateRailwayJson creates deterministic config payload', () => {
		const source = generateRailwayJson({
			appName: 'my-railway-app',
			region: 'us-east-1',
		})

		const parsed = JSON.parse(source) as {
			$schema: string
			build: { builder: string }
			deploy: { startCommand: string; healthcheckPath: string; restartPolicyType: string }
			metadata: { generatedBy: string; appName: string; region: string }
		}

		expect(parsed.$schema).toContain('railway.app')
		expect(parsed.metadata.appName).toBe('my-railway-app')
		expect(parsed.build.builder).toBe('DOCKERFILE')
		expect(parsed.deploy.startCommand).toBe('node ./server-bundled.js')
		expect(parsed.deploy.healthcheckPath).toBe('/health')
		expect(parsed.metadata.region).toBe('us-east-1')
	})

	test('writeRailwayJsonArtifact writes file into deploy directory', async () => {
		const root = await mkdtemp(join(tmpdir(), 'kora-railway-json-'))
		tempDirectories.push(root)

		const deployDirectory = join(root, '.kora', 'deploy')
		const path = await writeRailwayJsonArtifact(deployDirectory, {
			appName: 'my-railway-app',
			region: 'eu-west-1',
		})

		expect(path).toBe(join(deployDirectory, 'railway.json'))
		const source = await readFile(path, 'utf-8')
		const parsed = JSON.parse(source) as { metadata: { region: string } }
		expect(parsed.metadata.region).toBe('eu-west-1')
	})
})
