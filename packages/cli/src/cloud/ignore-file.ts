/**
 * Reads a `.koraignore`: files the repository keeps but the deployed app doesn't need (design
 * sources, recordings, fixtures), in `.gitignore` syntax. Supported: `*`, `?`, `**`, a trailing
 * `/` for directories, a leading or inner `/` to anchor to the file's folder, `!` to bring a
 * path back, and `#` comments. The last matching line wins, as in git; unlike git, `!` can also
 * bring back a file inside an ignored folder.
 */
export function compileIgnore(text: string): (path: string) => boolean {
	const rules: Array<{ readonly negate: boolean; readonly pattern: RegExp }> = []
	for (const raw of text.split(/\r?\n/)) {
		let line = raw.replace(/\s+$/, '')
		if (line === '' || line.startsWith('#')) continue
		const negate = line.startsWith('!')
		if (negate) line = line.slice(1)
		if (line.startsWith('\\')) line = line.slice(1)
		const directoryOnly = line.endsWith('/')
		if (directoryOnly) line = line.slice(0, -1)
		const anchored = line.includes('/')
		if (line.startsWith('/')) line = line.slice(1)
		if (line === '') continue
		const body = globToRegex(line)
		// A directory pattern matches everything under it; a plain one matches a file or a folder.
		const tail = directoryOnly ? '/.*' : '(?:/.*)?'
		rules.push({ negate, pattern: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}${tail}$`) })
	}
	return (path) => {
		let ignored = false
		for (const rule of rules) if (rule.pattern.test(path)) ignored = !rule.negate
		return ignored
	}
}

function globToRegex(glob: string): string {
	let out = ''
	for (let index = 0; index < glob.length; index += 1) {
		const character = glob[index] ?? ''
		if (character === '*') {
			if (glob[index + 1] === '*') {
				// `**/` is any number of folders; a trailing `**` is everything below.
				if (glob[index + 2] === '/') {
					out += '(?:.*/)?'
					index += 2
				} else {
					out += '.*'
					index += 1
				}
			} else {
				out += '[^/]*'
			}
		} else if (character === '?') {
			out += '[^/]'
		} else {
			out += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		}
	}
	return out
}
