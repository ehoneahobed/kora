import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { DoctorCheckResult } from './doctor-checks'

/** Directories that never hold the app's own schema (dependencies, build output, fixtures). */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
	'node_modules',
	'dist',
	'build',
	'out',
	'coverage',
	'fixtures',
	'__fixtures__',
	'__tests__',
	'.git',
	'.turbo',
	'.next',
	'.nuxt',
	'.svelte-kit',
	'.output',
	'.kora',
	'target',
])

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const TEST_FILE = /\.(?:test|spec)\.[^/\\]+$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/

/** A scan reads at most this many files and this many bytes per file: it must stay fast. */
const MAX_FILES = 5000
const MAX_FILE_BYTES = 512 * 1024

/** One `defineSchema({ collections: { ... } })` call found in a source file. */
export interface SchemaDefinitionSite {
	/** Path relative to the project root, with `/` separators. */
	file: string
	/** 1-based line of the `defineSchema` identifier. */
	line: number
	/** Top-level collection names the call declares. */
	collections: string[]
}

type Token =
	| { kind: 'id'; value: string; line: number }
	| { kind: 'str'; value: string; line: number }
	| { kind: 'punct'; value: string; line: number }

/**
 * Split source into the few token kinds the schema scan needs. Comments are dropped and
 * string contents are kept as one token, so a `defineSchema(` or a collection name that
 * only appears inside a comment or a string never counts. This is deliberately not a full
 * JavaScript parser: it only has to stay in step with brackets and quotes.
 */
function tokenize(source: string): Token[] {
	const tokens: Token[] = []
	let i = 0
	let line = 1
	const length = source.length
	while (i < length) {
		const ch = source.charAt(i)
		if (ch === '\n') {
			line++
			i++
		} else if (ch === ' ' || ch === '\t' || ch === '\r') {
			i++
		} else if (ch === '/' && source.charAt(i + 1) === '/') {
			while (i < length && source.charAt(i) !== '\n') i++
		} else if (ch === '/' && source.charAt(i + 1) === '*') {
			i += 2
			while (i < length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) {
				if (source.charAt(i) === '\n') line++
				i++
			}
			i += 2
		} else if (ch === "'" || ch === '"') {
			const start = line
			let value = ''
			i++
			while (i < length && source.charAt(i) !== ch && source.charAt(i) !== '\n') {
				if (source.charAt(i) === '\\') i++
				value += source.charAt(i)
				i++
			}
			i++
			tokens.push({ kind: 'str', value, line: start })
		} else if (ch === '`') {
			const start = line
			i++
			// A template literal is skipped whole, `${ ... }` included: its text is never a key.
			let depth = 0
			while (i < length) {
				const c = source.charAt(i)
				if (c === '\\') {
					i += 2
					continue
				}
				if (c === '\n') line++
				if (c === '$' && source.charAt(i + 1) === '{') {
					depth++
					i += 2
					continue
				}
				if (c === '}' && depth > 0) depth--
				else if (c === '`' && depth === 0) break
				i++
			}
			i++
			tokens.push({ kind: 'str', value: '', line: start })
		} else if (/[A-Za-z_$]/.test(ch)) {
			let end = i + 1
			while (end < length && /[\w$]/.test(source.charAt(end))) end++
			tokens.push({ kind: 'id', value: source.slice(i, end), line })
			i = end
		} else if (/[0-9]/.test(ch)) {
			let end = i + 1
			while (end < length && /[\w.]/.test(source.charAt(end))) end++
			tokens.push({ kind: 'str', value: '', line })
			i = end
		} else {
			tokens.push({ kind: 'punct', value: ch, line })
			i++
		}
	}
	return tokens
}

function isPunct(token: Token | undefined, value: string): boolean {
	return token?.kind === 'punct' && token.value === value
}

function isOpen(token: Token): boolean {
	return (
		token.kind === 'punct' && (token.value === '{' || token.value === '(' || token.value === '[')
	)
}

function isClose(token: Token): boolean {
	return (
		token.kind === 'punct' && (token.value === '}' || token.value === ')' || token.value === ']')
	)
}

/**
 * The property names at the top level of the object literal whose `{` is at `open`.
 * Handles `name: value`, `'quoted-name': value`, `name(...) {}` methods and shorthand
 * `name,` / `name }`; spreads and computed keys are skipped (their names are not known).
 */
function topLevelKeys(tokens: Token[], open: number): Map<string, number> {
	const keys = new Map<string, number>()
	let depth = 0
	for (let i = open; i < tokens.length; i++) {
		const token = tokens[i]
		if (!token) break
		if (isOpen(token)) {
			depth++
			continue
		}
		if (isClose(token)) {
			depth--
			if (depth === 0) break
			continue
		}
		if (depth !== 1 || (token.kind !== 'id' && token.kind !== 'str')) continue
		const before = tokens[i - 1]
		const after = tokens[i + 1]
		// A key starts after `{` or `,` (not after `:` where it is a value, not after `.`).
		if (!(isPunct(before, '{') || isPunct(before, ','))) continue
		if (token.kind === 'str' && token.value === '') continue
		if (isPunct(after, ':') || isPunct(after, ',') || isPunct(after, '}') || isPunct(after, '(')) {
			if (!keys.has(token.value)) keys.set(token.value, token.line)
		}
	}
	return keys
}

/** Index of the matching close bracket for the opener at `open`, or -1. */
function matching(tokens: Token[], open: number): number {
	let depth = 0
	for (let i = open; i < tokens.length; i++) {
		const token = tokens[i]
		if (!token) break
		if (isOpen(token)) depth++
		else if (isClose(token)) {
			depth--
			if (depth === 0) return i
		}
	}
	return -1
}

/**
 * Every `defineSchema({ collections: { ... } })` call in `source`, with the collection
 * names it declares. A call whose `collections` is not an object literal (a variable, a
 * spread of another module) is left out: its names are not knowable from the text.
 *
 * @param source - TypeScript or JavaScript source text
 * @param file - Path reported in each site
 */
export function findSchemaDefinitions(source: string, file: string): SchemaDefinitionSite[] {
	if (!source.includes('defineSchema')) return []
	const tokens = tokenize(source)
	const sites: SchemaDefinitionSite[] = []
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]
		if (token?.kind !== 'id' || token.value !== 'defineSchema') continue
		// `import { defineSchema }` and `export { defineSchema }` are not calls; neither is a
		// property access such as `kora.defineSchema` re-exported without a call.
		if (!isPunct(tokens[i + 1], '(') || !isPunct(tokens[i + 2], '{')) continue
		if (isPunct(tokens[i - 1], '.')) continue
		const end = matching(tokens, i + 2)
		if (end === -1) continue
		const argument = tokens.slice(i + 2, end + 1)
		let depth = 0
		for (let j = 0; j < argument.length; j++) {
			const inner = argument[j]
			if (!inner) break
			if (isOpen(inner)) depth++
			else if (isClose(inner)) depth--
			else if (
				depth === 1 &&
				(inner.kind === 'id' || inner.kind === 'str') &&
				inner.value === 'collections' &&
				isPunct(argument[j + 1], ':') &&
				isPunct(argument[j + 2], '{')
			) {
				const names = [...topLevelKeys(argument, j + 2).keys()]
				if (names.length > 0) sites.push({ file, line: token.line, collections: names })
				break
			}
		}
	}
	return sites
}

/**
 * Find every `defineSchema` call in the project's own source files. Skips dependencies,
 * build output, test files and test fixtures (`node_modules`, `dist`, `fixtures`, `*.test.ts`).
 *
 * @param projectRoot - Directory to scan
 */
export async function scanSchemaDefinitions(projectRoot: string): Promise<SchemaDefinitionSite[]> {
	const sites: SchemaDefinitionSite[] = []
	let scanned = 0
	const walk = async (directory: string): Promise<void> => {
		let entries: Dirent[]
		try {
			entries = await readdir(directory, { withFileTypes: true })
		} catch {
			return
		}
		entries.sort((a, b) => a.name.localeCompare(b.name))
		for (const entry of entries) {
			if (scanned >= MAX_FILES) return
			const path = join(directory, entry.name)
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(path)
				continue
			}
			if (
				!entry.isFile() ||
				!SOURCE_FILE.test(entry.name) ||
				TEST_FILE.test(entry.name) ||
				DECLARATION_FILE.test(entry.name)
			) {
				continue
			}
			scanned++
			let source: string
			try {
				source = await readFile(path, 'utf-8')
			} catch {
				continue
			}
			if (source.length > MAX_FILE_BYTES) continue
			sites.push(...findSchemaDefinitions(source, relative(projectRoot, path).split(sep).join('/')))
		}
	}
	await walk(projectRoot)
	return sites
}

/** Two definitions that declare some of the same collections. */
export interface DuplicateSchemaGroup {
	sites: SchemaDefinitionSite[]
	/** Collection names declared by more than one site of the group. */
	shared: string[]
}

/**
 * Group definition sites that share a collection name (transitively: A and B share one
 * name, B and C another, all three are one group). Sites with disjoint collections are
 * never grouped.
 */
export function groupDuplicateSchemas(sites: SchemaDefinitionSite[]): DuplicateSchemaGroup[] {
	const parent = sites.map((_, index) => index)
	const find = (index: number): number => {
		let root = index
		while (parent[root] !== root) root = parent[root] ?? root
		return root
	}
	const owner = new Map<string, number>()
	sites.forEach((site, index) => {
		for (const name of site.collections) {
			const first = owner.get(name)
			if (first === undefined) owner.set(name, index)
			else parent[find(index)] = find(first)
		}
	})
	const groups = new Map<number, SchemaDefinitionSite[]>()
	sites.forEach((site, index) => {
		const root = find(index)
		groups.set(root, [...(groups.get(root) ?? []), site])
	})
	const result: DuplicateSchemaGroup[] = []
	for (const members of groups.values()) {
		if (members.length < 2) continue
		const counts = new Map<string, number>()
		for (const member of members) {
			for (const name of member.collections) counts.set(name, (counts.get(name) ?? 0) + 1)
		}
		const shared = [...counts].filter(([, n]) => n > 1).map(([name]) => name)
		result.push({ sites: members, shared })
	}
	return result
}

/**
 * The `schema-duplicates` check: warn when more than one `defineSchema` call declares the
 * same collection names. A client schema and a server schema written twice drift apart
 * (a field added on one side is silently missing on the other); the fix is one exported
 * schema that the client, the sync server and `kora.config.ts` all import.
 *
 * @param projectRoot - Directory to scan
 * @param scan - Source scanner (tests inject one)
 */
export async function checkDuplicateSchemas(
	projectRoot: string,
	scan: (root: string) => Promise<SchemaDefinitionSite[]> = scanSchemaDefinitions,
): Promise<DoctorCheckResult> {
	const id = 'schema-duplicates'
	const title = 'One schema'
	let sites: SchemaDefinitionSite[]
	try {
		sites = await scan(projectRoot)
	} catch (error) {
		return {
			id,
			title,
			status: 'skip',
			message: `Could not scan the project sources: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	const groups = groupDuplicateSchemas(sites)
	if (groups.length === 0) {
		return {
			id,
			title,
			status: 'pass',
			message:
				sites.length === 0
					? 'No defineSchema() call found in the project sources.'
					: `${sites.length} defineSchema() call(s), none declaring the same collections.`,
		}
	}
	const described = groups.map((group) => {
		const where = group.sites.map((site) => `${site.file}:${site.line}`).join(', ')
		return `${group.shared.join(', ')} (${where})`
	})
	return {
		id,
		title,
		status: 'warn',
		message: `The same collections are defined by more than one defineSchema() call: ${described.join('; ')}.`,
		fix: 'Keep one schema: `export default defineSchema(...)` from a single module (for example src/schema.ts) and import it in the client app, the sync server entry and kora.config.ts. Delete the other definition.',
	}
}
