#!/usr/bin/env node
/**
 * Runs the Getting Started tutorial (docs/getting-started.md) verbatim against the local build
 * (DX-3): the first-run tutorial must work exactly as written.
 *
 * 1. Scaffolds the app with the page's own `npx create-kora-app@beta ...` command, run through
 *    this checkout's built CLI (`packages/cli/dist/create.js`, `--skip-install` added), and links
 *    the workspace's installed packages instead of installing from the registry.
 * 2. Builds the untouched scaffold (`tsc` + `vite build`): version 1 of the app.
 * 3. Applies the tutorial's edits: every block marked `<!-- docs-check: file <path> -->` whose
 *    path exists in the scaffold replaces that file, and every
 *    `<!-- docs-tutorial: insert <path> after <anchor> -->` block is inserted after the line
 *    containing `<anchor>`. Then builds again (`tsc` + `vite build`): version 2.
 * 4. In real Chromium (skipped with a notice when none is found; `--require-browser` fails
 *    instead): serves version 1 with createProductionServer, adds a todo, swaps in version 2 on
 *    the same origin, reloads, and checks that the todo written before the migration shows the
 *    new field's default and that new todos work.
 *
 * Run after `pnpm build`: node scripts/docs/check-getting-started.mjs [--require-browser]
 * Chromium: PW_CHROMIUM_PATH, else /opt/pw-browsers/chromium-*\/chrome-linux/chrome, else the
 * browser `playwright install chromium` installed.
 */
import { execFileSync } from 'node:child_process'
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const requireBrowser = process.argv.includes('--require-browser')
const page = readFileSync(join(repo, 'docs/getting-started.md'), 'utf8')
const fixtureModules = join(repo, 'e2e/fixture-app/node_modules')

let failed = 0
function check(ok, description, detail = '') {
	if (!ok) failed++
	console.log(`${ok ? 'PASS' : 'FAIL'} getting-started: ${description}`)
	if (!ok && detail) console.log(`       ${String(detail).slice(0, 400)}`)
}

// ---------------------------------------------------------------- the page's instructions
const scaffoldLine = page.split('\n').find((l) => l.startsWith('npx create-kora-app@beta my-app'))
if (!scaffoldLine)
	throw new Error('getting-started.md has no `npx create-kora-app@beta my-app` line')
const scaffoldArgs = scaffoldLine.replace('npx create-kora-app@beta', '').trim().split(/\s+/)

function pageBlocks() {
	const lines = page.split('\n')
	const files = []
	const inserts = []
	for (let i = 0; i < lines.length; i++) {
		const file = lines[i].trim().match(/^<!--\s*docs-check:\s*file\s+(\S+)\s*-->$/)
		const insert = lines[i]
			.trim()
			.match(/^<!--\s*docs-tutorial:\s*insert\s+(\S+)\s+after\s+(.+?)\s*-->$/)
		if (!file && !insert) continue
		let j = i + 1
		while (!lines[j].startsWith('```')) j++
		const body = []
		let k = j + 1
		while (!lines[k].startsWith('```')) body.push(lines[k++])
		if (file) files.push({ path: file[1], code: `${body.join('\n')}\n` })
		else inserts.push({ path: insert[1], anchor: insert[2], code: body.join('\n') })
		i = k
	}
	return { files, inserts }
}

// ---------------------------------------------------------------- scaffold
const work = mkdtempSync(join(tmpdir(), 'kora-getting-started-'))
const appDir = join(work, 'my-app')
const tools = join(fixtureModules, '.bin')

function run(cmd, args, cwd) {
	return execFileSync(cmd, args, { cwd, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'test' } })
}

async function viteBuild(outDir) {
	const vite = await import(pathToFileURL(join(fixtureModules, 'vite/dist/node/index.js')).href)
	const cwd = process.cwd()
	// The template's sqlite copy step resolves dist/ and node_modules/ against the cwd.
	process.chdir(appDir)
	try {
		await vite.build({
			root: appDir,
			logLevel: 'error',
			configFile: join(appDir, 'vite.config.ts'),
		})
	} finally {
		process.chdir(cwd)
	}
	cpSync(join(appDir, 'dist'), outDir, { recursive: true })
}

function typecheck(label) {
	try {
		run(join(tools, 'tsc'), ['-p', 'tsconfig.json', '--noEmit'], appDir)
		check(true, `${label}: tsc passes`)
	} catch (error) {
		check(false, `${label}: tsc passes`, `${error.stdout ?? ''}${error.stderr ?? ''}`)
	}
}

let server = null
let browser = null
try {
	run(
		process.execPath,
		[join(repo, 'packages/cli/dist/create.js'), ...scaffoldArgs, '--skip-install'],
		work,
	)
	check(existsSync(join(appDir, 'src/schema.ts')), `scaffold: ${scaffoldLine}`)

	const modules = join(appDir, 'node_modules')
	mkdirSync(join(modules, '@korajs'), { recursive: true })
	for (const entry of readdirSync(fixtureModules)) {
		if (entry === '@korajs' || entry.startsWith('.')) continue
		symlinkSync(join(fixtureModules, entry), join(modules, entry))
	}
	for (const entry of readdirSync(join(fixtureModules, '@korajs'))) {
		symlinkSync(join(fixtureModules, '@korajs', entry), join(modules, '@korajs', entry))
	}
	symlinkSync(join(repo, 'packages/cli'), join(modules, '@korajs/cli'))
	mkdirSync(join(modules, '.bin'), { recursive: true })

	typecheck('version 1 (as scaffolded)')
	const v1 = join(work, 'dist-v1')
	await viteBuild(v1)
	check(existsSync(join(v1, 'index.html')), 'version 1: vite build')

	const { files, inserts } = pageBlocks()
	let applied = 0
	for (const { path, code } of files) {
		if (!existsSync(join(appDir, path))) continue // a standalone example, not a scaffold edit
		writeFileSync(join(appDir, path), code)
		applied++
	}
	for (const { path, anchor, code } of inserts) {
		const source = readFileSync(join(appDir, path), 'utf8').split('\n')
		const at = source.findIndex((l) => l.includes(anchor))
		check(at >= 0, `edit anchor found in ${path}: ${anchor}`)
		if (at < 0) continue
		const indent = source[at].match(/^\s*/)?.[0] ?? ''
		source.splice(at + 1, 0, ...code.split('\n').map((l) => `${indent}${l}`))
		writeFileSync(join(appDir, path), source.join('\n'))
		applied++
	}
	check(applied >= 3, `tutorial edits applied (${applied})`)

	typecheck('version 2 (tutorial edits)')
	const v2 = join(work, 'dist-v2')
	await viteBuild(v2)
	check(existsSync(join(v2, 'index.html')), 'version 2: vite build')

	// ------------------------------------------------------------ browser
	const executablePath =
		process.env.PW_CHROMIUM_PATH ??
		(existsSync('/opt/pw-browsers')
			? readdirSync('/opt/pw-browsers')
					.filter((d) => /^chromium-\d+$/.test(d))
					.map((d) => join('/opt/pw-browsers', d, 'chrome-linux/chrome'))
					.find((p) => existsSync(p))
			: undefined)
	const require = createRequire(join(repo, 'e2e/package.json'))
	const { chromium } = require('@playwright/test')
	// Without an explicit binary, Playwright's own install (`playwright install chromium`).
	browser = await chromium.launch(executablePath ? { executablePath } : {}).catch((error) => {
		console.log(`SKIP getting-started: browser checks (${String(error).split('\n')[0]})`)
		if (requireBrowser) failed++
		return null
	})
	if (browser) {
		const { createProductionServer, MemoryServerStore } = await import(
			pathToFileURL(join(repo, 'packages/server/dist/index.js')).href
		)
		const port = 4900 + Math.floor(Math.random() * 90)
		const origin = `http://localhost:${port}`
		const serve = async (staticDir) => {
			server = createProductionServer({ store: new MemoryServerStore(), staticDir, port })
			await server.start()
		}
		// The offline app shell is checked elsewhere (NEW-DX-3); here every reload must reach
		// the server so version 2 replaces version 1.
		const ctx = await browser.newContext({ serviceWorkers: 'block' })
		const tab = await ctx.newPage()
		const addTodo = async (title) => {
			await tab.fill('input[placeholder="What needs to be done?"]', title)
			await tab.click('button[type="submit"]')
			await tab.getByText(title).waitFor({ timeout: 15_000 })
		}

		await serve(v1)
		await tab.goto(`${origin}/`)
		await tab.getByText('My Tasks').first().waitFor({ timeout: 30_000 })
		await addTodo('written at version 1')
		check(true, 'version 1 runs and stores a todo')
		await server.stop()

		await serve(v2)
		await tab.reload()
		await tab.getByText('written at version 1').waitFor({ timeout: 30_000 })
		const row = tab.locator('.todo-item', { hasText: 'written at version 1' })
		const rowText = (await row.textContent()) ?? ''
		check(
			rowText.includes('medium'),
			'after the migration the old todo shows priority "medium"',
			rowText,
		)
		await addTodo('written at version 2')
		const newRow =
			(await tab.locator('.todo-item', { hasText: 'written at version 2' }).textContent()) ?? ''
		check(newRow.includes('medium'), 'a new todo gets the default priority', newRow)
	}
} catch (error) {
	check(false, 'tutorial run', error?.stack ?? String(error))
} finally {
	await browser?.close().catch(() => {})
	await server?.stop?.().catch?.(() => {})
	if (!process.env.KEEP_TUTORIAL_APP) rmSync(work, { recursive: true, force: true })
	else console.log(`kept ${work}`)
}
process.exit(failed ? 1 : 0)
