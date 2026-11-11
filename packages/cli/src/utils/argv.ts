/**
 * Options that take a value, per command that also has subcommands. citty picks a command's
 * subcommand as its first argument without a leading dash, so `kora deploy --platform fly` would
 * be read as a subcommand named `fly`. Writing such options as `--name=value` avoids that.
 */
const VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
	deploy: ['platform', 'app', 'region'],
}

/** Joins `--option value` into `--option=value` for the options above. Everything else is untouched. */
export function foldOptionValues(argv: readonly string[]): string[] {
	const command = argv.find((arg) => !arg.startsWith('-'))
	const names = command ? VALUE_OPTIONS[command] : undefined
	if (!names) return [...argv]
	const folded: string[] = []
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? ''
		const next = argv[index + 1]
		if (names.some((name) => arg === `--${name}`) && next !== undefined && !next.startsWith('-')) {
			folded.push(`${arg}=${next}`)
			index += 1
		} else {
			folded.push(arg)
		}
	}
	return folded
}
