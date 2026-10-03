#!/usr/bin/env node
/**
 * Typechecks the TypeScript code blocks of the documentation against the BUILT packages (DX-3).
 *
 * Run `pnpm build` first: imports of `korajs`, `korajs/*` and `@korajs/*` resolve to each
 * package's `dist` type declarations, exactly what an installed app sees.
 *
 * Which files: every Markdown file under docs/ (except plans/, releases/, CHANGELOG.md and
 * node_modules), the root README.md, kora/README.md and every packages/<name>/README.md.
 * Which blocks: fences tagged ts, typescript or tsx. Each block is one module, checked in strict mode.
 *
 * Markers (HTML comments, invisible on the rendered page), on the lines just above a fence:
 *   <!-- docs-check: skip <reason> -->   intentionally partial snippet (a signature list, a
 *                                         fragment of a larger file). The reason is required.
 *   <!-- docs-check: continue -->        append this block to the previous checked block of the
 *                                         same page and check them as one module (tutorials).
 *   <!-- docs-check: standalone -->      check this block without the page prelude (a setup
 *                                         block that defines what the prelude declares).
 * A page-level hidden prelude declares what the page's snippets assume (an `app`, a schema):
 *   <!-- docs-check-prelude
 *   import { createApp } from 'korajs'
 *   declare const app: ...
 *   -->
 * The prelude is prepended to every later checked block of that page, minus the names the block
 * declares itself (its own imports and variables win); a new prelude replaces it,
 * and `<!-- docs-check-prelude -->` on one line clears it.
 *   <!-- docs-check: file src/schema.ts -->  write this block to that path in the page's own
 *                                         directory, so other blocks can import './src/schema'.
 *   <!-- docs-tutorial: ... -->          an edit check-getting-started.mjs applies to a
 *                                         scaffolded app; not checked on its own.
 *
 * Usage: node scripts/docs/check-code-blocks.mjs [--verbose] [file.md ...]
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const ts = require(require.resolve('typescript', { paths: [root] }))

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const explicitFiles = args.filter((a) => !a.startsWith('--'))

const EXCLUDED_DIRS = new Set(['node_modules', '.vitepress', 'plans', 'releases', 'public'])
const LANGS = new Set(['ts', 'typescript', 'tsx'])

function walk(dir) {
	const out = []
	for (const name of readdirSync(join(root, dir))) {
		if (EXCLUDED_DIRS.has(name)) continue
		const p = join(dir, name)
		if (statSync(join(root, p)).isDirectory()) out.push(...walk(p))
		else if (p.endsWith('.md') && name !== 'CHANGELOG.md') out.push(p)
	}
	return out
}

function docFiles() {
	if (explicitFiles.length > 0) return explicitFiles.map((f) => relative(root, resolve(f)))
	const files = ['README.md', 'kora/README.md', ...walk('docs')]
	for (const pkg of readdirSync(join(root, 'packages'))) {
		const readme = join('packages', pkg, 'README.md')
		try {
			statSync(join(root, readme))
			files.push(readme)
		} catch {
			// a package without a README has nothing to check
		}
	}
	return files
}

/** Splits a Markdown page into check units: { file, startLine, code, tsx, preludeLines }. */
function extractUnits(file) {
	const lines = readFileSync(join(root, file), 'utf8').split('\n')
	const units = []
	const problems = []
	let prelude = ''
	let skipped = 0
	let pendingMarker = null
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const trimmed = line.trim()
		if (trimmed.startsWith('<!-- docs-check-prelude')) {
			if (trimmed.endsWith('-->')) {
				// `<!-- docs-check-prelude -->` on one line clears the page prelude.
				prelude = ''
				continue
			}
			const body = []
			let j = i + 1
			while (j < lines.length && lines[j].trim() !== '-->') body.push(lines[j++])
			prelude = body.join('\n')
			i = j
			continue
		}
		if (/^<!--\s*docs-tutorial:/.test(trimmed)) {
			// An edit applied to a scaffolded app by check-getting-started.mjs: a fragment.
			pendingMarker = { kind: 'skip', arg: 'tutorial edit' }
			continue
		}
		const marker = trimmed.match(/^<!--\s*docs-check:\s*(skip|continue|file|standalone)\b(.*?)-->$/)
		if (marker) {
			const arg = marker[2].trim()
			if ((marker[1] === 'skip' || marker[1] === 'file') && arg === '') {
				problems.push(
					`${file}:${i + 1}: a ${marker[1]} marker needs ${marker[1] === 'skip' ? 'a reason' : 'a path'}`,
				)
			}
			pendingMarker = { kind: marker[1], arg }
			continue
		}
		const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*([\w-]*)/)
		if (!fence) {
			if (trimmed !== '') pendingMarker = null
			continue
		}
		const indent = fence[1].length
		const close = fence[2]
		const lang = fence[3]
		const body = []
		let j = i + 1
		while (j < lines.length && !lines[j].trim().startsWith(close)) {
			body.push(lines[j].slice(Math.min(indent, lines[j].length - lines[j].trimStart().length)))
			j++
		}
		const marked = pendingMarker
		pendingMarker = null
		const startLine = i + 2
		i = j
		if (!LANGS.has(lang)) continue
		if (marked?.kind === 'skip') {
			skipped++
			continue
		}
		const code = body.join('\n')
		if (marked?.kind === 'continue' && units.length > 0) {
			const prev = units[units.length - 1]
			prev.segments.push({ startLine, code })
			prev.tsx = prev.tsx || lang === 'tsx'
			continue
		}
		const path = marked?.kind === 'file' ? marked.arg : null
		const unitPrelude = marked?.kind === 'standalone' ? '' : prelude
		units.push({
			file,
			path,
			tsx: lang === 'tsx',
			prelude: unitPrelude,
			segments: [{ startLine, code }],
		})
	}
	return { units, problems, skipped }
}

const pkg = (name) => join(root, 'packages', name)
const typesDir = (pkgName, typesName) => join(pkg(pkgName), 'node_modules', '@types', typesName)

/** Names a module declares at its top level (imports, variables, functions, classes, types). */
function topLevelNames(code, tsx) {
	const source = ts.createSourceFile(
		tsx ? 'x.tsx' : 'x.ts',
		code,
		ts.ScriptTarget.ES2022,
		false,
		tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	)
	const names = new Set()
	const bindingNames = (node) => {
		if (ts.isIdentifier(node)) names.add(node.text)
		else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
			for (const element of node.elements) {
				if (!ts.isOmittedExpression(element)) bindingNames(element.name)
			}
		}
	}
	for (const statement of source.statements) {
		if (ts.isImportDeclaration(statement)) {
			const clause = statement.importClause
			if (clause?.name) names.add(clause.name.text)
			const bindings = clause?.namedBindings
			if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text)
			if (bindings && ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) names.add(element.name.text)
			}
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				bindingNames(declaration.name)
			}
		} else if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isEnumDeclaration(statement)) &&
			statement.name
		) {
			names.add(statement.name.text)
		}
	}
	return names
}

/**
 * The page prelude without the names the block declares itself: the block's own
 * `import { createApp }` or `const app = ...` replaces the prelude's, as a reader expects.
 */
function preludeFor(prelude, blockCode, tsx) {
	if (!prelude) return ''
	const own = topLevelNames(blockCode, tsx)
	if (own.size === 0) return prelude
	const source = ts.createSourceFile(
		'p.tsx',
		prelude,
		ts.ScriptTarget.ES2022,
		true,
		ts.ScriptKind.TSX,
	)
	const kept = []
	for (const statement of source.statements) {
		const text = prelude.slice(statement.getFullStart(), statement.getEnd())
		const names = topLevelNames(text.trim(), true)
		if (names.size === 0 || ![...names].some((name) => own.has(name))) {
			kept.push(text)
			continue
		}
		const bindings = ts.isImportDeclaration(statement)
			? statement.importClause?.namedBindings
			: undefined
		if (bindings && ts.isNamedImports(bindings)) {
			const remaining = bindings.elements
				.filter((element) => !own.has(element.name.text))
				.map((element) => element.getText(source))
			const typeOnly = statement.importClause?.isTypeOnly ? 'type ' : ''
			if (remaining.length > 0) {
				kept.push(
					`\nimport ${typeOnly}{ ${remaining.join(', ')} } from ${statement.moduleSpecifier.getText(source)}`,
				)
			}
		}
		// Any other statement declaring a name the block declares is dropped whole.
	}
	return kept.join('').replace(/^\n+/, '')
}

function slug(file) {
	return file.replace(/[^\w]+/g, '_')
}

// Under node_modules so linters skip the generated modules; module resolution still walks up
// to the root node_modules.
const outDir = join(root, 'node_modules', '.cache', 'kora-docs-check')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const files = docFiles()
const allProblems = []
const sources = new Map() // generated file -> mapping info
let unitCount = 0
let skippedCount = 0
for (const file of files) {
	const { units, problems, skipped } = extractUnits(file)
	allProblems.push(...problems)
	skippedCount += skipped
	units.forEach((unit, index) => {
		unitCount++
		// One directory per page, so `import ... from './schema'` finds the block marked
		// <!-- docs-check: file schema.ts --> on the same page.
		const name = unit.path
			? join(outDir, slug(file), unit.path)
			: join(outDir, slug(file), `__block_${index + 1}.${unit.tsx ? 'tsx' : 'ts'}`)
		mkdirSync(dirname(name), { recursive: true })
		const map = [] // [generatedLineStart, mdStartLine, lineCount]
		let text = ''
		let line = 0
		const prelude = preludeFor(
			unit.prelude,
			unit.segments.map((seg) => seg.code).join('\n'),
			unit.tsx,
		)
		if (prelude) {
			text += `${prelude}\n`
			line += prelude.split('\n').length
		}
		for (const seg of unit.segments) {
			const n = seg.code.split('\n').length
			map.push([line, seg.startLine, n])
			text += `${seg.code}\n`
			line += n
		}
		text += 'export {}\n'
		writeFileSync(name, text)
		sources.set(name, { file: unit.file, map, hasPrelude: Boolean(unit.prelude) })
	})
}

function exportTypes(dir) {
	const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
	const out = {}
	for (const [sub, target] of Object.entries(json.exports ?? {})) {
		const types =
			typeof target === 'object' && target !== null
				? (target.import?.types ?? target.types ?? target.default)
				: undefined
		if (typeof types === 'string' && types.endsWith('.d.ts')) {
			out[sub === '.' ? json.name : `${json.name}/${sub.slice(2)}`] = [join(dir, types)]
		}
	}
	return out
}

const paths = { ...exportTypes(join(root, 'kora')) }
for (const name of readdirSync(join(root, 'packages'))) {
	try {
		Object.assign(paths, exportTypes(pkg(name)))
	} catch {
		// not a package
	}
}
Object.assign(paths, {
	react: [typesDir('react', 'react')],
	'react/*': [`${typesDir('react', 'react')}/*`],
	'react-dom': [typesDir('react', 'react-dom')],
	'react-dom/*': [`${typesDir('react', 'react-dom')}/*`],
	vue: [join(root, 'kora/node_modules/vue')],
	svelte: [join(root, 'kora/node_modules/svelte')],
	'svelte/*': [join(root, 'kora/node_modules/svelte/*')],
	yjs: [join(pkg('react'), 'node_modules/yjs')],
	'better-sqlite3': [typesDir('auth', 'better-sqlite3')],
	ws: [typesDir('cli', 'ws')],
})

const options = {
	strict: true,
	noEmit: true,
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	jsx: ts.JsxEmit.ReactJSX,
	skipLibCheck: true,
	esModuleInterop: true,
	allowSyntheticDefaultImports: true,
	resolveJsonModule: true,
	lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
	types: ['node'],
	typeRoots: [join(pkg('auth'), 'node_modules/@types')],
	baseUrl: root,
	paths,
}

// What a Vite app and its third-party libraries provide. Third-party modules the docs use but
// the repository does not install are declared loosely: their own APIs are not ours to check.
const envFile = join(outDir, 'docs-env.d.ts')
writeFileSync(
	envFile,
	[
		'interface ImportMetaEnv { readonly [key: string]: string | boolean | undefined; readonly DEV: boolean; readonly PROD: boolean; readonly SSR: boolean; readonly MODE: string }',
		'interface ImportMeta { readonly env: ImportMetaEnv }',
		"declare module '*.vue' { const component: import('vue').DefineComponent; export default component }",
		"declare module '*?worker&url' { const url: string; export default url }",
		"declare module '*?url' { const url: string; export default url }",
		...[
			'@tiptap/react',
			'@tiptap/starter-kit',
			'@tiptap/extension-collaboration',
			'@tiptap/extension-collaboration-cursor',
			'react-router-dom',
			'express',
			'next',
			'next/navigation',
			'next/headers',
			'next/dynamic',
			'vite',
			'@vitejs/plugin-react',
			'@sveltejs/vite-plugin-svelte',
			'@vitejs/plugin-vue',
			'@tauri-apps/api',
			'@tauri-apps/api/core',
			'@tauri-apps/plugin-sql',
			'@testing-library/react',
			'playwright',
			'@playwright/test',
			'drizzle-orm/node-postgres',
			'pg',
			'postgres',
			'protobufjs',
		].map((m) => `declare module '${m}'`),
	].join('\n'),
)

const program = ts.createProgram([envFile, ...sources.keys()], options)
const diagnostics = ts.getPreEmitDiagnostics(program)
const errors = []
for (const d of diagnostics) {
	if (!d.file) {
		errors.push(`(global) ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
		continue
	}
	const info = sources.get(resolve(d.file.fileName))
	if (!info) continue // errors inside declaration files are not the docs' problem
	const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0)
	const seg = info.map.find(([start, , n]) => line >= start && line < start + n)
	const where = seg ? `${info.file}:${seg[1] + (line - seg[0])}` : `${info.file} (prelude)`
	errors.push(`${where}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, '\n  ')}`)
}

for (const p of allProblems) errors.push(p)
console.log(
	`docs code blocks: ${files.length} files, ${unitCount} checked units, ${skippedCount} skipped blocks`,
)
if (errors.length > 0) {
	for (const e of errors) console.error(e)
	console.error(
		`\n${errors.length} error(s). Fix the snippet, or mark an intentionally partial one with <!-- docs-check: skip <reason> -->.`,
	)
	process.exit(1)
}
if (verbose) console.log(`generated modules in ${relative(root, outDir)}`)
console.log('docs code blocks: OK')
