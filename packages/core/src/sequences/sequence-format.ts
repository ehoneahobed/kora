/**
 * Offline-safe sequence formatting.
 *
 * Format tokens:
 * - `{date}` → YYYYMMDD (current date)
 * - `{node4}` → first 4 characters of nodeId
 * - `{node8}` → first 8 characters of nodeId
 * - `{seq}` → zero-padded counter (default 4 digits)
 * - `{seq:N}` → zero-padded counter with N digits
 *
 * @example
 * ```typescript
 * formatSequenceValue('INV-{date}-{node4}-{seq}', 42, 'a1b2c3d4e5f6')
 * // → "INV-20260508-a1b2-0042"
 *
 * formatSequenceValue('ORDER-{seq:6}', 7, 'node-id')
 * // → "ORDER-000007"
 * ```
 */
export function formatSequenceValue(
	template: string,
	counter: number,
	nodeId: string,
	now?: Date,
): string {
	const date = now ?? new Date()
	const yyyy = String(date.getUTCFullYear())
	const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
	const dd = String(date.getUTCDate()).padStart(2, '0')
	const dateStr = `${yyyy}${mm}${dd}`

	return template.replace(/\{([^}]+)\}/g, (_match, token: string) => {
		if (token === 'date') return dateStr
		if (token === 'node4') return nodeId.slice(0, 4)
		if (token === 'node8') return nodeId.slice(0, 8)
		if (token === 'seq') return String(counter).padStart(4, '0')
		if (token.startsWith('seq:')) {
			const width = Number.parseInt(token.slice(4), 10)
			if (Number.isNaN(width) || width < 1) {
				return String(counter).padStart(4, '0')
			}
			return String(counter).padStart(width, '0')
		}
		// Unknown token — leave as-is
		return `{${token}}`
	})
}

/**
 * Default format when none is provided: `{name}-{seq:4}`.
 */
export function defaultSequenceFormat(name: string): string {
	return `${name}-{seq:4}`
}
