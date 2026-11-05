/** Makes a user id safe to use inside a database name. */
export function encodeDbNameComponent(value: string): string {
	let encoded = ''
	for (const char of value) {
		if (/^[A-Za-z0-9._-]$/.test(char)) {
			encoded += char
			continue
		}
		encoded += `_${char.codePointAt(0)?.toString(16) ?? '0'}`
	}
	return encoded || 'empty'
}
