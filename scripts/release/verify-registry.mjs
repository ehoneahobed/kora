#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const version = process.argv[2]
if (!version) throw new Error('Usage: node scripts/release/verify-registry.mjs <exact-version>')

const root = resolve(import.meta.dirname, '../..')
const packageDirs = ['kora', 'create-kora-app']
for (const entry of readdirSync(join(root, 'packages'))) packageDirs.push(join('packages', entry))
const packageNames = packageDirs
	.map((dir) => join(root, dir, 'package.json'))
	.filter(existsSync)
	.map((manifest) => JSON.parse(readFileSync(manifest, 'utf8')))
	.filter((manifest) => manifest.private !== true)
	.map((manifest) => manifest.name)

const attempts = Number.parseInt(process.env.KORA_REGISTRY_ATTEMPTS ?? '12', 10)
let missing = packageNames
for (let attempt = 1; attempt <= attempts; attempt++) {
	const checks = await Promise.all(
		missing.map(async (name) => {
			const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
			try {
				const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
				return response.ok ? null : `${name} (${response.status})`
			} catch (error) {
				return `${name} (${error instanceof Error ? error.message : String(error)})`
			}
		}),
	)
	missing = checks.filter((result) => result !== null)
	if (missing.length === 0) {
		console.log(`✓ ${packageNames.length} packages are publicly readable at ${version}`)
		process.exit(0)
	}
	if (attempt < attempts) {
		console.log(`Registry attempt ${attempt}/${attempts}: waiting for ${missing.length} package(s)`)
		await sleep(5000)
	}
}

throw new Error(
	`Canary ${version} was not publicly readable after ${attempts} attempt(s): ${missing.join(', ')}. Check npm staged publications before announcing or installing it.`,
)
