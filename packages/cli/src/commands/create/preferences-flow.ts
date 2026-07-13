import {
	type CreatePreferences,
	type PreferenceStore,
	getCreatePreferencesOrDefault,
	getDefaultCreatePreferences,
} from '../../prompts/preferences'
import type { PromptClient } from '../../prompts/prompt-client'
import {
	type AuthOption,
	type DatabaseOption,
	type DatabaseProviderOption,
	type FrameworkOption,
	type PlatformOption,
	determineTemplateFromSelections,
	isAuthValue,
	isDatabaseProviderValue,
	isDatabaseValue,
	isFrameworkValue,
	isPlatformValue,
} from './options'

export interface CreateFlags {
	platform?: string
	framework?: string
	auth?: string
	db?: string
	dbProvider?: string
	tailwind?: boolean
	sync?: boolean
	useDefaults: boolean
}

export interface PreferenceResolutionResult {
	platform: PlatformOption
	framework: FrameworkOption
	auth: AuthOption
	db: DatabaseOption
	dbProvider: DatabaseProviderOption
	tailwind: boolean
	sync: boolean
	template: ReturnType<typeof determineTemplateFromSelections>
	usedStoredPreferences: boolean
}

/**
 * Resolves scaffold options with precedence:
 * CLI flags > --yes defaults > stored preferences > interactive prompts.
 */
export async function resolveCreatePreferencesFlow(params: {
	flags: CreateFlags
	prompts: PromptClient
	store: PreferenceStore
}): Promise<PreferenceResolutionResult> {
	const { flags, prompts, store } = params
	const stored = store.getCreatePreferences()
	const base = getCreatePreferencesOrDefault(store)
	const hasExplicitFlags = hasExplicitPreferenceFlags(flags)
	const canOfferStored =
		!flags.useDefaults && !hasExplicitFlags && stored !== null && promptSupportsRichOptions()

	let effective: CreatePreferences = { ...base }
	let usedStoredPreferences = false

	if (flags.useDefaults) {
		effective = getDefaultCreatePreferences()
	} else if (canOfferStored && stored !== null) {
		const reuseStored = await prompts.select('Welcome back! Choose setup mode:', [
			{ label: formatStoredPreferenceLabel(stored), value: 'reuse' },
			{ label: 'Customize', value: 'customize' },
		])
		if (reuseStored === 'reuse') {
			effective = { ...stored }
			usedStoredPreferences = true
		}
	}

	if (flags.platform !== undefined) {
		if (!isPlatformValue(flags.platform)) {
			throw new Error(
				`Invalid --platform value "${flags.platform}". Expected one of: web, desktop-tauri.`,
			)
		}
		effective.platform = flags.platform
	} else if (!flags.useDefaults && !usedStoredPreferences) {
		effective.platform = await prompts.select('Platform:', [
			{ label: 'Web (browser)', value: 'web' },
			{ label: 'Desktop (Tauri — native SQLite)', value: 'desktop-tauri' },
		])
	}

	const isTauri = effective.platform === 'desktop-tauri'

	if (isTauri) {
		// Tauri currently uses React and native SQLite on the client.
		// The sync server remains configurable so the same desktop scaffold can
		// run local-only, LAN sync, or cloud sync without switching templates.
		effective.framework = 'react'
		effective.tailwind = false
		effective.auth = 'none'

		if (flags.sync !== undefined) {
			effective.sync = flags.sync
		} else if (!flags.useDefaults && !usedStoredPreferences) {
			effective.sync = await prompts.confirm('Enable multi-device sync?', true)
		}

		if (flags.db !== undefined) {
			if (!isDatabaseValue(flags.db)) {
				throw new Error(
					`Invalid --db value "${flags.db}". Expected one of: none, sqlite, postgres.`,
				)
			}
			effective.db = flags.db
		} else if (!effective.sync) {
			effective.db = 'none'
		} else if (!flags.useDefaults && !usedStoredPreferences) {
			effective.db = await prompts.select('Sync server database:', [
				{ label: 'SQLite (zero-config; local, LAN, small teams)', value: 'sqlite' },
				{ label: 'PostgreSQL (production-scale)', value: 'postgres' },
			])
		}

		if (effective.db === 'none') {
			effective.sync = false
		}

		if (effective.db !== 'postgres') {
			effective.dbProvider = 'none'
		} else if (flags.dbProvider !== undefined) {
			if (!isDatabaseProviderValue(flags.dbProvider)) {
				throw new Error(
					`Invalid --db-provider value "${flags.dbProvider}". Expected one of: none, local, supabase, neon, railway, vercel-postgres, custom.`,
				)
			}
			effective.dbProvider = flags.dbProvider
		} else if (!flags.useDefaults && !usedStoredPreferences) {
			effective.dbProvider = await prompts.select('Database provider:', [
				{ label: 'Local Postgres', value: 'local' },
				{ label: 'Supabase', value: 'supabase' },
				{ label: 'Neon', value: 'neon' },
				{ label: 'Railway', value: 'railway' },
				{ label: 'Vercel Postgres', value: 'vercel-postgres' },
				{ label: 'Custom connection string', value: 'custom' },
			])
		}
	} else {
		if (flags.framework !== undefined) {
			if (!isFrameworkValue(flags.framework)) {
				throw new Error(
					`Invalid --framework value "${flags.framework}". Expected one of: react, vue, svelte, solid.`,
				)
			}
			effective.framework = flags.framework
		} else if (!flags.useDefaults && !usedStoredPreferences) {
			effective.framework = await prompts.select('UI framework:', [
				{ label: 'React', value: 'react' },
				{ label: 'Vue 3', value: 'vue' },
				{ label: 'Svelte 5', value: 'svelte' },
				{ label: 'Solid (coming soon)', value: 'solid', disabled: true },
			])
		}

		if (flags.auth !== undefined) {
			if (!isAuthValue(flags.auth)) {
				throw new Error(
					`Invalid --auth value "${flags.auth}". Expected one of: none, email-password, oauth.`,
				)
			}
			effective.auth = flags.auth
		} else if (!flags.useDefaults && !usedStoredPreferences) {
			effective.auth = await prompts.select('Authentication:', [
				{ label: 'None', value: 'none' },
				{ label: 'Email + Password (coming soon)', value: 'email-password', disabled: true },
				{ label: 'OAuth (coming soon)', value: 'oauth', disabled: true },
			])
		}

		if (flags.tailwind !== undefined) {
			effective.tailwind = flags.tailwind
		} else if (!flags.useDefaults && !usedStoredPreferences) {
			effective.tailwind = await prompts.confirm('Use Tailwind CSS?', true)
		}

		if (flags.sync !== undefined) {
			effective.sync = flags.sync
		} else if (!flags.useDefaults && !usedStoredPreferences) {
			effective.sync = await prompts.confirm('Enable multi-device sync?', true)
		}

		if (flags.db !== undefined) {
			if (!isDatabaseValue(flags.db)) {
				throw new Error(
					`Invalid --db value "${flags.db}". Expected one of: none, sqlite, postgres.`,
				)
			}
			effective.db = flags.db
		} else if (!effective.sync) {
			effective.db = 'none'
		} else if (!flags.useDefaults && !usedStoredPreferences) {
			effective.db = await prompts.select('Server-side database:', [
				{ label: 'SQLite (zero-config)', value: 'sqlite' },
				{ label: 'PostgreSQL (production-scale)', value: 'postgres' },
			])
		}

		if (effective.db !== 'postgres') {
			effective.dbProvider = 'none'
		} else if (flags.dbProvider !== undefined) {
			if (!isDatabaseProviderValue(flags.dbProvider)) {
				throw new Error(
					`Invalid --db-provider value "${flags.dbProvider}". Expected one of: none, local, supabase, neon, railway, vercel-postgres, custom.`,
				)
			}
			effective.dbProvider = flags.dbProvider
		} else if (!flags.useDefaults && !usedStoredPreferences) {
			effective.dbProvider = await prompts.select('Database provider:', [
				{ label: 'Local Postgres', value: 'local' },
				{ label: 'Supabase', value: 'supabase' },
				{ label: 'Neon', value: 'neon' },
				{ label: 'Railway', value: 'railway' },
				{ label: 'Vercel Postgres', value: 'vercel-postgres' },
				{ label: 'Custom connection string', value: 'custom' },
			])
		}
	}

	const template = determineTemplateFromSelections({
		platform: effective.platform,
		framework: effective.framework,
		tailwind: effective.tailwind,
		sync: effective.sync,
		db: effective.db,
	})

	return {
		platform: effective.platform,
		framework: effective.framework,
		auth: effective.auth,
		db: effective.db,
		dbProvider: effective.dbProvider,
		tailwind: effective.tailwind,
		sync: effective.sync,
		template,
		usedStoredPreferences,
	}
}

export function shouldSavePreferences(flags: CreateFlags): boolean {
	return !flags.useDefaults
}

export function saveResolvedPreferences(
	store: PreferenceStore,
	resolution: Omit<PreferenceResolutionResult, 'template' | 'usedStoredPreferences'> & {
		packageManager: CreatePreferences['packageManager']
	},
): void {
	store.saveCreatePreferences({
		platform: resolution.platform,
		framework: resolution.framework,
		tailwind: resolution.tailwind,
		sync: resolution.sync,
		db: resolution.db,
		dbProvider: resolution.dbProvider,
		auth: resolution.auth,
		packageManager: resolution.packageManager,
	})
}

function hasExplicitPreferenceFlags(flags: CreateFlags): boolean {
	return (
		flags.platform !== undefined ||
		flags.framework !== undefined ||
		flags.auth !== undefined ||
		flags.db !== undefined ||
		flags.dbProvider !== undefined ||
		flags.tailwind !== undefined ||
		flags.sync !== undefined
	)
}

function promptSupportsRichOptions(): boolean {
	return typeof process !== 'undefined' && process.stdin.isTTY && process.stdout.isTTY
}

function formatStoredPreferenceLabel(preferences: CreatePreferences): string {
	if (preferences.platform === 'desktop-tauri') {
		return `Use previous settings (tauri-desktop + ${preferences.packageManager})`
	}
	const syncLabel = preferences.sync ? `sync/${preferences.db}` : 'local-only'
	const styleLabel = preferences.tailwind ? 'tailwind' : 'css'
	return `Use previous settings (${preferences.framework} + ${styleLabel} + ${syncLabel} + ${preferences.packageManager})`
}
