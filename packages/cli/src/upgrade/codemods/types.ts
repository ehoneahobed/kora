/**
 * The codemod interface for `kora upgrade`.
 *
 * A codemod inspects the project's source for something an upgrade changed and returns
 * findings (always) and edits (only when a rewrite is safe and unambiguous). A codemod that
 * cannot prove a rewrite is correct reports a finding with a documentation link instead.
 *
 * To add one: create `<name>.ts` exporting a `Codemod`, append it to `CODEMODS` in
 * `registry.ts`, and cover it with a fixture-based test next to it.
 */

/** A source file handed to codemods. Read once per run and shared. */
export interface SourceFile {
	/** Path relative to the project root, with forward slashes. */
	path: string
	text: string
}

export interface CodemodContext {
	/** Absolute project root. */
	projectRoot: string
	/** Project source files (ts, tsx, js, jsx, mjs, cjs, vue, svelte), node_modules excluded. */
	files: SourceFile[]
	/** Lowest Kora version declared before the upgrade; null when it could not be determined. */
	fromVersion: string | null
	/** The version being upgraded to. */
	toVersion: string
}

export type FindingSeverity = 'warn' | 'info'

/** Something the developer should look at. Never changes a file. */
export interface CodemodFinding {
	/** Relative path of the file. */
	file: string
	/** One-based line. */
	line: number
	severity: FindingSeverity
	message: string
}

/** A text replacement in one file. Offsets are UTF-16 indexes into the file's `text`. */
export interface CodemodEdit {
	file: string
	start: number
	end: number
	replacement: string
}

export interface CodemodResult {
	findings: CodemodFinding[]
	/**
	 * Safe, unambiguous rewrites. Applied only when the developer passes `--apply-codemods`;
	 * otherwise they are listed as a count. Leave empty unless the rewrite cannot change behavior.
	 */
	edits: CodemodEdit[]
}

export interface Codemod {
	/** Stable kebab-case id, shown in output. */
	id: string
	/** One-line summary of what changed in Kora. */
	title: string
	/** First release in which the change shipped. The codemod runs when an upgrade crosses it. */
	introducedIn: string
	/** Documentation link printed with the findings. */
	docs: string
	/** Inspect the project. Must be read-only and deterministic. */
	run(context: CodemodContext): CodemodResult
}
