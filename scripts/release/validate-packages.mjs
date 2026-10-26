#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
/**
 * Build-independent, registry-safe validation of every publishable workspace package.
 *
 * `changeset publish --dry-run` is not a true dry run: Changesets can still invoke
 * `npm publish` for each package. This script uses `pnpm pack` in an isolated temp
 * directory, then checks the exact packed manifest and every declared entry point.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
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
	const archives = new Map()
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
		archives.set(manifest.name, archive)
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

	const cliArchive = archives.get('@korajs/cli')
	if (!cliArchive) throw new Error('The packed release has no @korajs/cli archive')
	const fixture = join(temp, 'cli-consumer')
	mkdirSync(fixture)
	const fileDependencies = Object.fromEntries(
		[...archives]
			.filter(([name]) => name !== '@korajs/cli')
			.map(([name, archive]) => [name, `file:${archive}`]),
	)
	writeFileSync(
		join(fixture, 'package.json'),
		`${JSON.stringify(
			{
				name: 'kora-packed-cli-smoke',
				private: true,
				type: 'module',
				dependencies: { '@korajs/cli': `file:${cliArchive}` },
				pnpm: { overrides: fileDependencies },
			},
			null,
			2,
		)}\n`,
	)
	const install = spawnSync('pnpm', ['install', '--ignore-scripts'], {
		cwd: fixture,
		encoding: 'utf8',
		env: { ...process.env, CI: 'true' },
		timeout: 120_000,
	})
	if (install.status !== 0) {
		throw new Error(
			`Could not install the packed CLI fixture${install.error ? ` (${install.error.message})` : ''}:\n${install.stderr || install.stdout}`,
		)
	}
	const smokeCommands = [
		[
			'exec',
			'create-kora-app',
			'smoke-app',
			'--template',
			'react-basic',
			'--skip-install',
			'--yes',
		],
		['exec', 'kora', '--help'],
		[
			'exec',
			'node',
			'-e',
			"const cli=require('@korajs/cli'); if(typeof cli.generateTypes!=='function') process.exit(1)",
		],
		[
			'exec',
			'node',
			'-e',
			"const vite=require('@korajs/cli/vite'); if(typeof vite.koraServiceWorker!=='function') process.exit(1)",
		],
	]
	for (const args of smokeCommands) {
		const smoke = spawnSync('pnpm', args, { cwd: fixture, encoding: 'utf8' })
		if (smoke.status !== 0) {
			throw new Error(
				`Packed CLI smoke failed (${args.join(' ')}):\n${smoke.stderr || smoke.stdout}`,
			)
		}
	}
	const scaffoldManifest = JSON.parse(
		readFileSync(join(fixture, 'smoke-app', 'package.json'), 'utf8'),
	)
	const expectedVersion = publishable.find(({ manifest }) => manifest.name === '@korajs/cli')
		?.manifest.version
	if (scaffoldManifest.dependencies?.korajs !== expectedVersion) {
		throw new Error(
			`Packed create-kora-app wrote korajs@${scaffoldManifest.dependencies?.korajs}; expected ${expectedVersion}`,
		)
	}
	scaffoldManifest.pnpm = scaffoldManifest.pnpm ?? {}
	scaffoldManifest.pnpm.overrides = {
		...fileDependencies,
		'@korajs/cli': `file:${cliArchive}`,
	}
	writeFileSync(
		join(fixture, 'smoke-app', 'package.json'),
		`${JSON.stringify(scaffoldManifest, null, 2)}\n`,
	)
	for (const args of [['install', '--frozen-lockfile=false'], ['build']]) {
		const appCheck = spawnSync('pnpm', args, {
			cwd: join(fixture, 'smoke-app'),
			encoding: 'utf8',
			env: { ...process.env, CI: 'true' },
			timeout: 180_000,
		})
		if (appCheck.status !== 0) {
			throw new Error(
				`Packed scaffold check failed (pnpm ${args.join(' ')}${appCheck.error ? `; ${appCheck.error.message}` : ''}):\n${appCheck.stderr || appCheck.stdout}`,
			)
		}
	}
	for (const artifact of ['dist/index.html', 'dist/sw.js']) {
		if (!existsSync(join(fixture, 'smoke-app', artifact))) {
			throw new Error(`Packed scaffold production build did not emit ${artifact}`)
		}
	}
	console.log(
		'✓ packed @korajs/cli install, scaffold, executable, ESM/CommonJS entries and production app build',
	)
	console.log(
		`\nValidated ${publishable.length} publishable packages; no registry writes were made.`,
	)
} finally {
	rmSync(temp, { recursive: true, force: true })
}
