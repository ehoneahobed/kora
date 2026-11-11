/**
 * One setting an app reads from its environment, as its `.env.example` declares it.
 *
 * `.env.example` is the app's list of settings. A comment block describes the variables
 * directly below it (up to the next blank line), and bracketed tags in the comment set the rules:
 *
 * ```bash
 * # [required] [secret] Sends invitation and verification emails.
 * RESEND_API_KEY=
 *
 * # [development] Where emails go instead of being sent, outside production.
 * DEV_MAILBOX=./mail
 * ```
 *
 * - `[required]`: production can't run correctly without it.
 * - `[secret]`: a credential; hosts store it encrypted and never display it.
 * - `[development]`: only used outside production; hosts don't ask for it.
 *
 * Every host reads the same file without running the app's code: Kora Cloud, `kora doctor`,
 * and any other platform.
 */
export interface EnvDeclaration {
	readonly name: string
	/** The value written in the file: a default or an example. Never treat it as a real secret. */
	readonly example: string
	/** The comment above it, without tags, or null when there is none. */
	readonly description: string | null
	readonly required: boolean
	readonly secret: boolean
	readonly developmentOnly: boolean
}

const VARIABLE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/
const TAG = /\[(required|secret|development)\]/gi

function unquote(value: string): string {
	const trimmed = value.trim()
	const quoted = /^(['"])(.*)\1$/.exec(trimmed)
	if (quoted) return quoted[2] ?? ''
	// An unquoted value ends at an inline comment.
	return trimmed.replace(/\s+#.*$/, '')
}

/**
 * Reads the settings an app declares in its `.env.example`. Lines that aren't comments,
 * blank lines or `NAME=value` are ignored, so any existing file parses.
 *
 * @param text - The contents of `.env.example`
 * @returns One entry per variable, in file order; a repeated name keeps its first entry
 */
export function parseEnvExample(text: string): EnvDeclaration[] {
	const declarations: EnvDeclaration[] = []
	const seen = new Set<string>()
	let comment: string[] = []
	let groupStarted = false
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		if (line === '') {
			comment = []
			groupStarted = false
			continue
		}
		if (line.startsWith('#')) {
			// A comment after variables starts a new group.
			if (groupStarted) {
				comment = []
				groupStarted = false
			}
			comment.push(line.replace(/^#+\s?/, ''))
			continue
		}
		const match = VARIABLE.exec(line)
		if (!match?.[1]) continue
		groupStarted = true
		const name = match[1]
		if (seen.has(name)) continue
		seen.add(name)
		const joined = comment.join(' ')
		const tags = new Set([...joined.matchAll(TAG)].map((tag) => (tag[1] ?? '').toLowerCase()))
		const description = joined.replace(TAG, '').replace(/\s+/g, ' ').trim()
		declarations.push({
			name,
			example: unquote(match[2] ?? ''),
			description: description.length > 0 ? description : null,
			required: tags.has('required') && !tags.has('development'),
			secret: tags.has('secret'),
			developmentOnly: tags.has('development'),
		})
	}
	return declarations
}

/**
 * The declared settings production needs that `env` doesn't have.
 *
 * @param declarations - From {@link parseEnvExample}
 * @param env - The environment to check, such as `process.env`
 */
export function missingRequiredEnv(
	declarations: readonly EnvDeclaration[],
	env: Readonly<Record<string, string | undefined>>,
): EnvDeclaration[] {
	return declarations.filter(
		(declaration) => declaration.required && !env[declaration.name]?.trim(),
	)
}
