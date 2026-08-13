#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
/**
 * Build-independent, registry-safe validation of every publishable workspace package.
 *
 * `changeset publish --dry-run` is not a true dry run: Changesets can still invoke
 * `npm publish` for each package. This script uses `pnpm pack` in an isolated temp
 * directory, then checks the exact packed manifest and every declared entry point.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const packageDirs = ['kora', 'create-kora-app']
for (const entry of readdirSync(join(root, 'packages'))) {
	packageDirs.push(join('packages', entry))
}

const publishable = packageDirs
	.map((dir) => ({ dir, manifest: join(root, dir, 'package.json') }))
	.filter(({ manifest }) => existsSync(manifest))
	.map(({ dir, manifest }) => ({ dir, manifest: JSON.parse(readFileSync(manifest, 'utf8')) }))
	.filter(({ manifest }) => manifest.private !== true)

function declaredEntryPoints(manifest) {
	const entries = new Set()
	for (const field of ['main', 'module', 'types', 'bin']) {
		const value = manifest[field]
		if (typeof value === 'string') entries.add(value)
		if (value && typeof value === 'object') {
			for (const target of Object.values(value)) if (typeof target === 'string') entries.add(target)
		}
	}
	function visit(value) {
		if (typeof value === 'string') {
			if (value.startsWith('./') && !value.includes('*')) entries.add(value)
			return
		}
		if (value && typeof value === 'object') for (const nested of Object.values(value)) visit(nested)
	}
	visit(manifest.exports)
	return [...entries].map((entry) => entry.replace(/^\.\//, ''))
}

const temp = mkdtempSync(join(tmpdir(), 'kora-release-pack-'))
try {
	for (const { dir, manifest } of publishable) {
		const before = new Set(readdirSync(temp))
		const packed = spawnSync('pnpm', ['pack', '--pack-destination', temp], {
			cwd: join(root, dir),
			encoding: 'utf8',
		})
		if (packed.status !== 0) {
			throw new Error(`Failed to pack ${manifest.name}:\n${packed.stderr || packed.stdout}`)
		}
		const archiveName = readdirSync(temp).find((name) => !before.has(name))
		if (!archiveName) throw new Error(`pnpm pack produced no archive for ${manifest.name}`)
		const archive = join(temp, archiveName)
		const listing = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' })
		if (listing.status !== 0) throw new Error(`Could not inspect ${archiveName}: ${listing.stderr}`)
		const files = new Set(listing.stdout.trim().split('\n'))
		const packedManifestResult = spawnSync('tar', ['-xOf', archive, 'package/package.json'], {
			encoding: 'utf8',
		})
		if (packedManifestResult.status !== 0) {
			throw new Error(`Could not read the packed manifest for ${manifest.name}`)
		}
		const packedManifest = JSON.parse(packedManifestResult.stdout)
		if (packedManifest.name !== manifest.name || packedManifest.version !== manifest.version) {
			throw new Error(`Packed identity mismatch for ${manifest.name}@${manifest.version}`)
		}
		if (JSON.stringify(packedManifest).includes('workspace:')) {
			throw new Error(`${manifest.name} still contains a workspace: dependency after packing`)
		}
		for (const entry of declaredEntryPoints(packedManifest)) {
			if (!files.has(`package/${entry}`)) {
				throw new Error(`${manifest.name} declares missing packed entry point: ${entry}`)
			}
		}
		console.log(
			`✓ ${manifest.name}@${manifest.version} (${Math.ceil(statSync(archive).size / 1024)} KiB, ${files.size} files)`,
		)
	}
	console.log(
		`\nValidated ${publishable.length} publishable packages; no registry writes were made.`,
	)
} finally {
	rmSync(temp, { recursive: true, force: true })
}
