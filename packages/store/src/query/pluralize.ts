/**
 * Minimal pluralization/singularization utilities for relation name resolution.
 * Handles common English patterns — not meant to be exhaustive.
 */

function isVowel(char: string | undefined): boolean {
	if (!char) return false
	return 'aeiouAEIOU'.includes(char)
}

/**
 * Pluralize a word using common English rules.
 *
 * @example
 * ```
 * pluralize('project') // 'projects'
 * pluralize('category') // 'categories'
 * pluralize('match') // 'matches'
 * ```
 */
export function pluralize(word: string): string {
	if (word.endsWith('s')) return word
	if (word.endsWith('y') && !isVowel(word[word.length - 2])) {
		return `${word.slice(0, -1)}ies`
	}
	if (word.endsWith('sh') || word.endsWith('ch') || word.endsWith('x') || word.endsWith('z')) {
		return `${word}es`
	}
	return `${word}s`
}

/**
 * Singularize a word using common English rules.
 *
 * @example
 * ```
 * singularize('projects') // 'project'
 * singularize('categories') // 'category'
 * singularize('matches') // 'match'
 * ```
 */
export function singularize(word: string): string {
	if (word.endsWith('ies') && !isVowel(word[word.length - 4])) {
		return `${word.slice(0, -3)}y`
	}
	if (
		word.endsWith('shes') ||
		word.endsWith('ches') ||
		word.endsWith('xes') ||
		word.endsWith('zes')
	) {
		return word.slice(0, -2)
	}
	if (word.endsWith('ses')) {
		return word.slice(0, -2)
	}
	if (word.endsWith('s') && !word.endsWith('ss')) {
		return word.slice(0, -1)
	}
	return word
}
