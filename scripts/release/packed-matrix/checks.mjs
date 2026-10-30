/**
 * The checks of the packed-artifact release matrix.
 *
 * Every check starts from the tarballs `pnpm pack` produced (never from the workspace), installs
 * them into a throwaway project the way a user's `npm install` would, and runs the thing a user
 * runs. A check owns its own directory, ports and (for Postgres) database; the only thing checks
 * share is the read-only consumer install and the scaffolded app, each of which is a check of its
 * own, so a failure there is reported once, by name, and everything that needs it says so.
 */
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { freePort } from './consumer/common.mjs'
import { CONSUMER_DIR, ROOT, run, runChecked, start } from './context.mjs'
import { Blocked, Partial, Skip } from './runner.mjs'

/** The sync template: its own server, auth routes, service worker and offline badge. */
const SYNC_TEMPLATE = 'react-tailwind-sync'

/** The 12 browser templates of the A7 offline-readiness suite (`tauri-react` cannot run in one). */
export const WEB_TEMPLATES = [
	'react-basic',
	'react-tailwind',
	'react-sync',
	'react-tailwind-sync',
	'vue-basic',
	'vue-tailwind',
	'vue-sync',
	'vue-tailwind-sync',
	'svelte-basic',
	'svelte-tailwind',
	'svelte-sync',
	'svelte-tailwind-sync',
]

const AUTH_SECRET = 'matrix-secret-that-is-long-enough-0123456789'
const ADMIN_TOKEN = 'matrix-admin-token'
const METRICS_TOKEN = 'matrix-metrics-token'

/** Packages the shared consumer depends on directly; the rest arrive as their dependencies. */
const CONSUMER_PACKAGES = [
	'korajs',
	'create-kora-app',
	'@korajs/cli',
	'@korajs/server',
	'@korajs/auth',
	'@korajs/store',
	'@korajs/core',
]

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function consumer(ctx) {
	if (!ctx.shared.consumer) throw new Error('the consumer install has not run')
	return ctx.shared.consumer
}

function copyScripts(target, names) {
	for (const name of names) copyFileSync(join(CONSUMER_DIR, name), join(target, name))
}

/**
 * Runs a consumer-side script; a failure carries the script's own "FAILED:" line (the assertion
 * that broke) as the first line, which is what the summary table prints.
 */
function runScript(dir, script, env, { tsx = false, timeoutMs = 240_000 } = {}) {
	const args = tsx ? ['--import', 'tsx', script] : [script]
	const result = run('node', args, { cwd: dir, env, timeoutMs })
	if (result.status === 0) return result.stdout
	const failed = /FAILED: (.*)/.exec(result.stderr)?.[1]
	throw new Error(
		`${failed ?? `${script} exited ${result.status ?? 'without a status'}${result.error ? ` (${result.error.message})` : ''}`}\n${result.stdout.slice(-2500)}\n${result.stderr.slice(-2500)}`,
	)
}

function postgresUrl() {
	const url = process.env.KORA_PG_TEST_URL
	if (!url) throw new Skip('KORA_PG_TEST_URL is not set (no Postgres to test against)')
	return url
}

/** A database of its own on the Postgres server; `drop()` removes it. */
function createPostgresDatabase(ctx) {
	const base = postgresUrl()
	const env = { KORA_PG_URL: base }
	const created = runChecked('node', ['pg-database.mjs', 'create'], { cwd: consumer(ctx), env })
	const { name, url } = JSON.parse(created.trim().split('\n').pop() ?? '{}')
	if (!name || !url) throw new Error(`pg-database.mjs create printed no database: ${created}`)
	return {
		url,
		drop: () => run('node', ['pg-database.mjs', 'drop', name], { cwd: consumer(ctx), env }),
	}
}

/** Scaffolds `template` with the packed `create-kora-app`, installs it from the tarballs. */
function scaffold(ctx, template, dir, { build }) {
	const name = `app-${template}`
	runChecked(
		join(consumer(ctx), 'node_modules', '.bin', 'create-kora-app'),
		[name, '--template', template, '--skip-install', '--yes'],
		{ cwd: dir, env: { NODE_ENV: 'test' } },
	)
	const appDir = join(dir, name)
	const manifestPath = join(appDir, 'package.json')
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
	const expected = ctx.version('korajs')
	if (manifest.dependencies?.korajs !== expected) {
		throw new Error(
			`the packed create-kora-app wrote korajs@${manifest.dependencies?.korajs}; the packed korajs is ${expected}`,
		)
	}
	manifest.pnpm = { ...manifest.pnpm, overrides: ctx.overrides() }
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
	runChecked('pnpm', ['install', '--frozen-lockfile=false'], { cwd: appDir, timeoutMs: 600_000 })
	for (const [pkg, version] of ctx.versions) {
		const installed = join(appDir, 'node_modules', ...pkg.split('/'), 'package.json')
		if (existsSync(installed) && JSON.parse(readFileSync(installed, 'utf8')).version !== version) {
			throw new Error(`${pkg} in the scaffolded app is not the packed ${version}`)
		}
	}
	if (build) runChecked('pnpm', ['build'], { cwd: appDir, timeoutMs: 600_000 })
	return appDir
}

/**
 * Starts the scaffolded sync template's own server (`node --import tsx server.ts`, what
 * `pnpm start` runs) in production on SQLite or on a Postgres database.
 */
async function bootTemplateServer(ctx, appDir, { dataDir, databaseUrl }) {
	const port = await freePort()
	const env = {
		NODE_ENV: 'production',
		PORT: String(port),
		KORA_AUTH_SECRET: AUTH_SECRET,
		KORA_ADMIN_TOKEN: ADMIN_TOKEN,
		KORA_METRICS_TOKEN: METRICS_TOKEN,
		...(databaseUrl
			? { DATABASE_URL: databaseUrl }
			: {
					KORA_SERVER_DB: join(dataDir, 'server.db'),
					KORA_AUTH_DB: join(dataDir, 'auth.db'),
				}),
	}
	const server = await start('node', ['--import', 'tsx', 'server.ts'], {
		cwd: appDir,
		env,
		ready: /Kora app running at/,
		timeoutMs: 90_000,
	})
	return { url: `http://localhost:${port}`, stop: server.stop, output: server.output }
}

function doctorJson(appDir, args, env = {}) {
	const result = run(join(appDir, 'node_modules', '.bin', 'kora'), ['doctor', '--json', ...args], {
		cwd: appDir,
		env,
		timeoutMs: 120_000,
	})
	let report
	try {
		report = JSON.parse(result.stdout)
	} catch {
		throw new Error(
			`kora doctor ${args.join(' ')} printed no JSON (exit ${result.status}):\n${result.stdout.slice(-1500)}\n${result.stderr.slice(-1500)}`,
		)
	}
	return { report, status: result.status, byId: new Map(report.checks.map((c) => [c.id, c])) }
}

function expectChecks(byId, expected, label) {
	const wrong = []
	for (const [id, status] of Object.entries(expected)) {
		const check = byId.get(id)
		if (!check) wrong.push(`${id} is missing`)
		else if (check.status !== status) wrong.push(`${id} is ${check.status} (${check.message})`)
	}
	if (wrong.length > 0) throw new Error(`${label}: ${wrong.join('; ')}`)
}

function noFailures(report, label) {
	const failed = report.checks.filter((check) => check.status === 'fail')
	if (failed.length > 0) {
		throw new Error(`${label}: ${failed.map((c) => `${c.id}: ${c.message}`).join('; ')}`)
	}
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** @returns {Array<{ id: string, title: string, needs?: string[], profile: 'smoke' | 'full', run: (ctx: any) => Promise<string | void> }>} */
export function buildChecks() {
	const checks = []
	const add = (check) => checks.push({ profile: 'smoke', ...check })

	add({
		id: 'pack-validate',
		title: 'baseline: 16 packages pack, CLI installs, ESM/CJS entries, scaffold, production build',
		run: async () => {
			const out = runChecked('node', [join(ROOT, 'scripts/release/validate-packages.mjs')], {
				cwd: ROOT,
				timeoutMs: 600_000,
			})
			const count = /Validated (\d+) publishable packages/.exec(out)?.[1]
			return `${count ?? '?'} packages validated`
		},
	})

	add({
		id: 'consumer-install',
		title: 'tarballs install into a clean project; better-sqlite3 binding loads',
		run: async (ctx) => {
			const dir = ctx.dir('consumer')
			ctx.installConsumer(dir, { packages: CONSUMER_PACKAGES })
			for (const name of CONSUMER_PACKAGES) {
				const installed = JSON.parse(
					readFileSync(join(dir, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
				)
				if (installed.version !== ctx.version(name)) {
					throw new Error(`${name}: installed ${installed.version}, packed ${ctx.version(name)}`)
				}
			}
			copyScripts(dir, readdirSync(CONSUMER_DIR))
			// Opening a SQLite server store proves the native binding is present.
			writeFileSync(
				join(dir, 'binding.mjs'),
				"import { createSqliteServerStore } from '@korajs/server'\nconst store = await createSqliteServerStore({ filename: ':memory:' })\nawait store.close()\nconsole.log('binding ok')\n",
			)
			runChecked('node', ['binding.mjs'], { cwd: dir })
			ctx.shared.consumer = dir
			return `${CONSUMER_PACKAGES.length} packages at their packed versions`
		},
	})

	for (const store of ['sqlite', 'postgres']) {
		add({
			id: `server-${store}`,
			title: `packed Node server: startup, /health, locks, auth, sync, restart (${store})`,
			needs: ['consumer-install'],
			run: async (ctx) => {
				if (store === 'postgres') postgresUrl()
				const dir = ctx.dir(`server-${store}`)
				runScript(consumer(ctx), 'server-smoke.mjs', {
					NODE_ENV: 'production',
					KORA_SMOKE_STORE: store,
					KORA_SMOKE_DIR: dir,
					KORA_EXPECT_SERVER_VERSION: ctx.version('@korajs/server'),
					...(store === 'postgres' ? { KORA_PG_URL: postgresUrl() } : {}),
				})
				return `${store}: health, operational locks, shell, bad token refused, 2-device sync, data plane, restart`
			},
		})
	}

	add({
		id: 'instant-updates',
		title: 'packed store.instantUpdates: first callback before commit, no divergence',
		needs: ['consumer-install'],
		run: async (ctx) => {
			runScript(consumer(ctx), 'instant-updates-smoke.mjs', { NODE_ENV: 'production' })
			return 'callback before commit, commit keeps the row once, durable opt-out, no divergence event'
		},
	})

	add({
		id: 'access-blob',
		title: 'packed access rules and central blobs with real accounts: grant, refuse, pull, revoke',
		needs: ['consumer-install'],
		run: async (ctx) => {
			runScript(consumer(ctx), 'access-blob-smoke.mjs', {
				NODE_ENV: 'production',
				KORA_ACCESS_DIR: ctx.dir('access-blob'),
			})
			return 'owner-only reads, grant delivers live, view write refused, edit write lands, blob bytes gated, revoke retracts'
		},
	})

	add({
		id: 'scaffold-app',
		title: `packed create-kora-app scaffolds ${SYNC_TEMPLATE}; installs from tarballs; production build`,
		needs: ['consumer-install'],
		run: async (ctx) => {
			const dir = ctx.dir('scaffold')
			const appDir = scaffold(ctx, SYNC_TEMPLATE, dir, { build: true })
			for (const artifact of ['dist/index.html', 'dist/sw.js']) {
				if (!existsSync(join(appDir, artifact))) throw new Error(`the build emitted no ${artifact}`)
			}
			ctx.shared.app = appDir
			return `${SYNC_TEMPLATE} built (index.html, sw.js)`
		},
	})

	for (const store of ['sqlite', 'postgres']) {
		add({
			id: `template-server-${store}`,
			title: `scaffolded template server in production on ${store}: sign up, sync, restart, sign in`,
			needs: ['scaffold-app'],
			run: async (ctx) => {
				const appDir = ctx.shared.app
				const dataDir = ctx.dir(`template-server-${store}`)
				const pg = store === 'postgres' ? createPostgresDatabase(ctx) : null
				copyScripts(appDir, ['common.mjs'])
				copyFileSync(
					join(CONSUMER_DIR, 'template-server-smoke.mjs'),
					join(appDir, 'matrix-template-smoke.mjs'),
				)
				let server = null
				try {
					for (const phase of ['seed', 'verify']) {
						server = await bootTemplateServer(ctx, appDir, {
							dataDir,
							...(pg ? { databaseUrl: pg.url } : {}),
						})
						runScript(
							appDir,
							'matrix-template-smoke.mjs',
							{
								KORA_TEMPLATE_PHASE: phase,
								KORA_TEMPLATE_URL: server.url,
								KORA_TEMPLATE_DIR: dataDir,
								KORA_EXPECT_SERVER_VERSION: ctx.version('@korajs/server'),
							},
							{ tsx: true },
						)
						await server.stop()
						server = null
					}
				} finally {
					if (server) await server.stop()
					pg?.drop()
				}
				return `${store}: /health, shell, sign up, device sync, restart, sign in, new device receives data`
			},
		})
	}

	add({
		id: 'cli-doctor',
		title: 'packed `kora doctor` and `kora doctor --production` on the built app',
		needs: ['scaffold-app'],
		run: async (ctx) => {
			const appDir = ctx.shared.app
			const plain = doctorJson(appDir, ['--skip-network'])
			noFailures(plain.report, 'kora doctor')
			expectChecks(
				plain.byId,
				{ schema: 'pass', worker: 'pass', 'package-versions': 'pass' },
				'doctor',
			)
			if (plain.status !== 0) throw new Error(`kora doctor exited ${plain.status}`)
			const production = doctorJson(appDir, ['--production', '--skip-network'], {
				NODE_ENV: 'production',
			})
			noFailures(production.report, 'kora doctor --production')
			expectChecks(
				production.byId,
				{
					'production-worker-delivery': 'pass',
					'production-isolation-headers': 'pass',
					'production-runtime-storage': 'pass',
				},
				'doctor --production',
			)
			return 'doctor and doctor --production: schema, worker and WASM delivery, isolation, storage'
		},
	})

	add({
		id: 'cli-doctor-url',
		title: 'packed `kora doctor --production --url` probes the packed template server',
		needs: ['scaffold-app'],
		run: async (ctx) => {
			const appDir = ctx.shared.app
			const server = await bootTemplateServer(ctx, appDir, { dataDir: ctx.dir('doctor-url') })
			try {
				const probe = doctorJson(appDir, ['--production', '--url', server.url], {
					NODE_ENV: 'production',
				})
				noFailures(probe.report, 'kora doctor --production --url')
				expectChecks(
					probe.byId,
					{
						'production-server-health': 'pass',
						'production-server-protocol': 'pass',
						'production-server-auth': 'pass',
					},
					'doctor --url',
				)
				const health = probe.byId.get('production-server-health')?.message ?? ''
				if (!health.includes(ctx.version('@korajs/server'))) {
					throw new Error(`the probe did not see the packed server version: ${health}`)
				}
			} finally {
				await server.stop()
			}
			return 'server health, protocol 2 and required authentication read from the running packed server'
		},
	})

	for (const store of ['sqlite', 'postgres']) {
		add({
			id: `cli-doctor-db-${store}`,
			title: `packed \`kora doctor --db\` preflights a production ${store} database written by the packed server`,
			needs: ['scaffold-app'],
			run: async (ctx) => {
				const appDir = ctx.shared.app
				const dataDir = ctx.dir(`doctor-db-${store}`)
				const pg = store === 'postgres' ? createPostgresDatabase(ctx) : null
				try {
					const server = await bootTemplateServer(ctx, appDir, {
						dataDir,
						...(pg ? { databaseUrl: pg.url } : {}),
					})
					await server.stop()
					const target = pg ? pg.url : join(dataDir, 'server.db')
					const preflight = doctorJson(appDir, ['--db', target, '--dry-run-migrations', '--strict'])
					noFailures(preflight.report, `kora doctor --db (${store})`)
					const db = preflight.report.checks.filter((check) => check.id.startsWith('db-'))
					if (db.length === 0) throw new Error('doctor --db ran no database check')
					const notPassing = db.filter((check) => check.status !== 'pass')
					if (notPassing.length > 0) {
						throw new Error(
							`database checks that do not pass: ${notPassing.map((c) => `${c.id} ${c.status}: ${c.message}`).join('; ')}`,
						)
					}
					if (preflight.status !== 0)
						throw new Error(`doctor --db --strict exited ${preflight.status}`)
					return `${store}: ${db.length} read-only database checks pass (--strict)`
				} finally {
					pg?.drop()
				}
			},
		})
	}

	add({
		id: 'cli-upgrade',
		title:
			'packed `kora upgrade`: dry run, apply from beta.12 specifiers, install, doctor, registry lookup',
		needs: ['scaffold-app'],
		run: async (ctx) => {
			const dir = ctx.dir('upgrade')
			const projectDir = join(dir, 'project')
			// Everything but build output and installed modules: the project as a user has it.
			cpSync(ctx.shared.app, projectDir, {
				recursive: true,
				filter: (source) =>
					!/(^|\/)(node_modules|dist|\.kora)(\/|$)/.test(source.slice(ctx.shared.app.length)),
			})
			const manifestPath = join(projectDir, 'package.json')
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
			const prior = '1.0.0-beta.12'
			for (const section of ['dependencies', 'devDependencies']) {
				for (const name of Object.keys(manifest[section] ?? {})) {
					if (name === 'korajs' || name.startsWith('@korajs/')) manifest[section][name] = prior
				}
			}
			writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
			// The packed CLI, resolved from the tarball the same way the project would get it.
			const kora = join(consumer(ctx), 'node_modules', '.bin', 'kora')
			const target = ctx.version('korajs')
			// A real install of the project at the prior specifiers (tarballs win through overrides).
			runChecked('pnpm', ['install', '--frozen-lockfile=false'], {
				cwd: projectDir,
				env: { CI: 'false' },
				timeoutMs: 600_000,
			})
			const before = readFileSync(manifestPath, 'utf8')
			const dry = run(kora, ['upgrade', '--dry-run', '--to', target], {
				cwd: projectDir,
				env: { CI: 'false' },
			})
			if (dry.status !== 0)
				throw new Error(`upgrade --dry-run exited ${dry.status}:\n${dry.stdout}\n${dry.stderr}`)
			if (!dry.stdout.includes(`${prior} -> ${target}`)) {
				throw new Error(
					`the dry run did not plan ${prior} -> ${target}:\n${dry.stdout.slice(-1500)}`,
				)
			}
			if (readFileSync(manifestPath, 'utf8') !== before)
				throw new Error('--dry-run changed package.json')

			const applied = run(kora, ['upgrade', '--to', target, '--yes'], {
				cwd: projectDir,
				env: { CI: 'false' },
				timeoutMs: 600_000,
			})
			if (applied.status !== 0) {
				throw new Error(
					`upgrade --to ${target} exited ${applied.status}:\n${applied.stdout.slice(-2500)}\n${applied.stderr.slice(-1500)}`,
				)
			}
			const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
			const stale = ['dependencies', 'devDependencies'].flatMap((section) =>
				Object.entries(after[section] ?? {}).filter(
					([name, spec]) => (name === 'korajs' || name.startsWith('@korajs/')) && spec !== target,
				),
			)
			if (stale.length > 0)
				throw new Error(`specifiers not upgraded to ${target}: ${JSON.stringify(stale)}`)
			if (!applied.stdout.includes('All checks passed')) {
				throw new Error(
					`the upgrade did not finish with a passing kora doctor:\n${applied.stdout.slice(-1500)}`,
				)
			}
			const installed = JSON.parse(
				readFileSync(join(projectDir, 'node_modules', 'korajs', 'package.json'), 'utf8'),
			).version
			if (installed !== target) throw new Error(`installed korajs is ${installed}, not ${target}`)

			// A move to an older version is refused without --allow-downgrade.
			const downgrade = run(kora, ['upgrade', '--dry-run', '--to', prior], {
				cwd: projectDir,
				env: { CI: 'false' },
			})
			if (downgrade.status === 0) throw new Error(`a downgrade to ${prior} was not refused`)

			// The registry lookup path (--tag), against the real registry.
			const tagged = run(kora, ['upgrade', '--dry-run', '--tag', 'latest'], {
				cwd: projectDir,
				env: { CI: 'false' },
				timeoutMs: 60_000,
			})
			if (tagged.status !== 0 || !/dist-tag latest/.test(tagged.stdout)) {
				throw new Error(
					`upgrade --dry-run --tag latest failed (exit ${tagged.status}):\n${tagged.stdout.slice(-1200)}\n${tagged.stderr.slice(-800)}`,
				)
			}
			return `dry run, apply ${prior} -> ${target}, install, doctor, downgrade refusal, --tag latest`
		},
	})

	for (const [id, spec, label] of [
		['upgrade-data-beta12', '1.0.0-beta.12', 'beta.12'],
		['upgrade-data-latest', 'latest', 'the latest published release'],
		['upgrade-data-canary', 'canary', 'the latest canary'],
	]) {
		add({
			id,
			title: `data written by ${label} (device + server databases) survives the packed candidate`,
			needs: ['consumer-install'],
			run: async (ctx) => {
				const dir = ctx.dir(id)
				const priorDir = join(dir, 'prior')
				const dataDir = join(dir, 'data')
				for (const path of [priorDir, dataDir]) mkdirSync(path, { recursive: true })
				writeFileSync(
					join(priorDir, 'package.json'),
					`${JSON.stringify(
						{
							name: 'kora-prior-release',
							private: true,
							type: 'module',
							dependencies: { korajs: spec, '@korajs/server': spec, ws: '^8.18.0' },
							pnpm: { onlyBuiltDependencies: ['better-sqlite3', 'esbuild', 'protobufjs'] },
						},
						null,
						2,
					)}\n`,
				)
				const install = run('pnpm', ['install', '--frozen-lockfile=false'], {
					cwd: priorDir,
					timeoutMs: 300_000,
				})
				if (install.status !== 0) {
					const text = `${install.stdout}\n${install.stderr}`
					if (
						spec === 'canary' &&
						/No matching version|ERR_PNPM_NO_MATCHING_VERSION|dist-tag/.test(text)
					) {
						throw new Skip('the registry has no canary dist-tag yet')
					}
					throw new Error(
						`could not install the prior release (${spec}) from the registry:\n${text.slice(-1500)}`,
					)
				}
				const priorVersion = JSON.parse(
					readFileSync(join(priorDir, 'node_modules', 'korajs', 'package.json'), 'utf8'),
				).version
				copyFileSync(join(CONSUMER_DIR, 'common.mjs'), join(priorDir, 'common.mjs'))
				copyFileSync(join(CONSUMER_DIR, 'upgrade-writer.mjs'), join(priorDir, 'upgrade-writer.mjs'))
				runScript(priorDir, 'upgrade-writer.mjs', { KORA_UPGRADE_DIR: dataDir })
				runScript(consumer(ctx), 'upgrade-reader.mjs', {
					NODE_ENV: 'production',
					KORA_UPGRADE_DIR: dataDir,
					KORA_PRIOR_VERSION: priorVersion,
				})
				return `${priorVersion} -> ${ctx.version('korajs')}: all records kept, unsent write uploaded, new device converges`
			},
		})
	}

	add({
		id: 'offline-templates',
		title: 'A7 offline-readiness suite on templates installed from the packed tarballs',
		needs: ['consumer-install'],
		run: async (ctx) => {
			const templates = ctx.templates === 'all' ? WEB_TEMPLATES : (ctx.templates ?? [SYNC_TEMPLATE])
			const unknown = templates.filter((name) => !WEB_TEMPLATES.includes(name))
			if (unknown.length > 0) throw new Error(`not a web template: ${unknown.join(', ')}`)
			const result = run('pnpm', ['--filter', 'kora-e2e', 'test:offline'], {
				cwd: ROOT,
				timeoutMs: 45 * 60_000,
				env: {
					KORA_PACKED_DIR: ctx.packedDir,
					// Install exactly the tarballs this run packed and validated; do not pack again.
					KORA_PACKED_EXACT: '1',
					KORA_OFFLINE_APPS_DIR: ctx.dir('offline-apps'),
					// Scaffold with the CLI that is IN the tarball, not the workspace build.
					KORA_OFFLINE_CREATE_ENTRY: join(
						consumer(ctx),
						'node_modules',
						'@korajs',
						'cli',
						'dist',
						'create.js',
					),
					KORA_OFFLINE_TEMPLATES: templates.join(','),
				},
			})
			const passed = /(\d+) passed/.exec(result.stdout)?.[1] ?? '0'
			const failed = /(\d+) failed/.exec(result.stdout)?.[1] ?? '0'
			if (result.status !== 0 || failed !== '0') {
				const failures = result.stdout
					.split('\n')
					.filter((line) => /^\s*(✘|x)\s/.test(line) || /\bfailed\b/.test(line))
					.slice(0, 12)
					.join('\n')
				throw new Error(
					`offline-readiness suite failed (${failed} failed, ${passed} passed) on ${templates.join(', ')}:\n${failures}\n${result.stdout.slice(-2500)}\n${result.stderr.slice(-1500)}`,
				)
			}
			return `${passed} tests passed on ${templates.length} template(s): ${templates.join(', ')}`
		},
	})

	add({
		id: 'browser-app',
		title:
			'Chromium on packed apps: auth-bound namespacing, offline write, refresh, reconnect, non-root base path',
		needs: ['consumer-install'],
		run: async (ctx) => {
			const result = run('pnpm', ['--filter', 'kora-e2e', 'test:packed'], {
				cwd: ROOT,
				timeoutMs: 30 * 60_000,
				env: {
					KORA_PACKED_DIR: ctx.packedDir,
					KORA_PACKED_EXACT: '1',
					KORA_OFFLINE_APPS_DIR: ctx.dir('browser-apps'),
					KORA_OFFLINE_CREATE_ENTRY: join(
						consumer(ctx),
						'node_modules',
						'@korajs',
						'cli',
						'dist',
						'create.js',
					),
				},
			})
			const passed = /(\d+) passed/.exec(result.stdout)?.[1] ?? '0'
			const failed = /(\d+) failed/.exec(result.stdout)?.[1] ?? '0'
			if (result.status !== 0 || failed !== '0') {
				const failures = result.stdout
					.split('\n')
					.filter((line) => /^\s*(✘|x)\s/.test(line) || /Error:|expect\(/.test(line))
					.slice(0, 14)
					.join('\n')
				throw new Error(
					`browser scenarios failed (${failed} failed, ${passed} passed):\n${failures}\n${result.stdout.slice(-3000)}\n${result.stderr.slice(-1500)}`,
				)
			}
			return `${passed} browser scenarios passed: per-user databases, offline write survives refresh and uploads on reconnect, worker and WASM under /kora-base/`
		},
	})

	add({
		id: 'tauri-template',
		title:
			'packed tauri-react template: installs, type-checks, frontend builds, Rust plugin resolves',
		needs: ['consumer-install'],
		profile: 'full',
		run: async (ctx) => {
			const dir = ctx.dir('tauri')
			const appDir = scaffold(ctx, 'tauri-react', dir, { build: false })
			runChecked(join(appDir, 'node_modules', '.bin', 'tsc'), ['--noEmit'], { cwd: appDir })
			runChecked(join(appDir, 'node_modules', '.bin', 'vite'), ['build'], { cwd: appDir })
			if (!existsSync(join(appDir, 'node_modules', '@korajs', 'tauri', 'plugin', 'Cargo.toml'))) {
				throw new Error('the packed @korajs/tauri ships no Rust plugin (plugin/Cargo.toml)')
			}
			const cargo = run('cargo', ['--version'], { cwd: appDir })
			if (cargo.status !== 0) throw new Skip('no Rust toolchain (cargo) on this machine')
			const cwd = join(appDir, 'src-tauri')
			const resolved = run('cargo', ['metadata', '--format-version', '1'], {
				cwd,
				timeoutMs: 600_000,
			})
			if (resolved.status !== 0) {
				throw new Error(
					`cargo metadata failed (the Rust dependency graph does not resolve):\n${resolved.stderr.slice(-2500)}`,
				)
			}
			const packages = JSON.parse(resolved.stdout).packages.map((p) => p.name)
			if (!packages.includes('tauri-plugin-kora-sqlite')) {
				throw new Error('the Rust graph does not contain tauri-plugin-kora-sqlite')
			}
			const webkit = run('pkg-config', ['--exists', 'webkit2gtk-4.1'], { cwd })
			if (webkit.status !== 0) {
				if (process.env.KORA_MATRIX_REQUIRE_CARGO_CHECK === '1') {
					throw new Error('KORA_MATRIX_REQUIRE_CARGO_CHECK=1 but webkit2gtk-4.1 is not installed')
				}
				throw new Partial(
					'frontend type-checks and builds and the Rust graph resolves; cargo check NOT run (no webkit2gtk-4.1 here)',
				)
			}
			const compiled = run('cargo', ['check', '--lib'], { cwd, timeoutMs: 25 * 60_000 })
			if (compiled.status !== 0) {
				throw new Error(`cargo check failed:\n${compiled.stderr.slice(-3000)}`)
			}
			return 'frontend type-checks and builds; cargo check compiles the app and the Kora SQLite plugin'
		},
	})

	add({
		id: 'c1-snapshot-device',
		title: 'a C1 snapshot device and an operations device converge on packed artifacts',
		run: async () => {
			throw new Blocked(
				'blocked: C1 unbuilt (record snapshots, docs/design/fast-first-sync.md section 3)',
			)
		},
	})

	return checks
}
