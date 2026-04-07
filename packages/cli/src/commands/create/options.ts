import type { TemplateName } from '../../types'

export type FrameworkOption = 'react' | 'vue' | 'svelte' | 'solid'
export type AuthOption = 'none' | 'email-password' | 'oauth'
export type DatabaseOption = 'none' | 'sqlite' | 'postgres'
export type DatabaseProviderOption =
	| 'none'
	| 'local'
	| 'supabase'
	| 'neon'
	| 'railway'
	| 'vercel-postgres'
	| 'custom'

export interface TemplateSelectionInput {
	tailwind: boolean
	sync: boolean
	db: DatabaseOption
}

/**
 * Converts high-level scaffold selections into the currently supported
 * concrete template names.
 */
export function determineTemplateFromSelections(input: TemplateSelectionInput): TemplateName {
	const shouldSync = input.sync && input.db !== 'none'
	if (input.tailwind && shouldSync) return 'react-tailwind-sync'
	if (input.tailwind && !shouldSync) return 'react-tailwind'
	if (!input.tailwind && shouldSync) return 'react-sync'
	return 'react-basic'
}

export function isFrameworkValue(value: string): value is FrameworkOption {
	return value === 'react' || value === 'vue' || value === 'svelte' || value === 'solid'
}

export function isAuthValue(value: string): value is AuthOption {
	return value === 'none' || value === 'email-password' || value === 'oauth'
}

export function isDatabaseValue(value: string): value is DatabaseOption {
	return value === 'none' || value === 'sqlite' || value === 'postgres'
}

export function isDatabaseProviderValue(value: string): value is DatabaseProviderOption {
	return (
		value === 'none' ||
		value === 'local' ||
		value === 'supabase' ||
		value === 'neon' ||
		value === 'railway' ||
		value === 'vercel-postgres' ||
		value === 'custom'
	)
}
