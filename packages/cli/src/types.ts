/** Supported package managers */
export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

/** Available project templates */
export const TEMPLATES = [
	'react-tailwind-sync',
	'react-tailwind',
	'react-sync',
	'react-basic',
	'vue-sync',
	'vue-basic',
	'vue-tailwind-sync',
	'vue-tailwind',
	'svelte-sync',
	'svelte-basic',
	'svelte-tailwind-sync',
	'svelte-tailwind',
	'tauri-react',
] as const
export type TemplateName = (typeof TEMPLATES)[number]

/** Metadata for a project template */
export interface TemplateInfo {
	name: TemplateName
	label: string
	description: string
}

/** Available templates with their descriptions */
export const TEMPLATE_INFO: readonly TemplateInfo[] = [
	{
		name: 'react-tailwind-sync',
		label: 'React + Tailwind (with sync)',
		description: 'Polished dark-themed app with Tailwind CSS and sync server (Recommended)',
	},
	{
		name: 'react-tailwind',
		label: 'React + Tailwind (local-only)',
		description: 'Polished dark-themed app with Tailwind CSS — no sync server',
	},
	{
		name: 'react-sync',
		label: 'React + CSS (with sync)',
		description: 'Clean CSS app with sync server included',
	},
	{
		name: 'react-basic',
		label: 'React + CSS (local-only)',
		description: 'Clean CSS app — no sync server',
	},
	{
		name: 'vue-sync',
		label: 'Vue 3 + CSS (with sync)',
		description: 'Vue composables with sync server included',
	},
	{
		name: 'vue-basic',
		label: 'Vue 3 + CSS (local-only)',
		description: 'Vue composables — no sync server',
	},
	{
		name: 'vue-tailwind-sync',
		label: 'Vue 3 + Tailwind (with sync)',
		description: 'Polished Vue app with Tailwind CSS and sync server',
	},
	{
		name: 'vue-tailwind',
		label: 'Vue 3 + Tailwind (local-only)',
		description: 'Polished Vue app with Tailwind CSS — no sync server',
	},
	{
		name: 'svelte-sync',
		label: 'Svelte 5 + CSS (with sync)',
		description: 'Svelte stores with sync server included',
	},
	{
		name: 'svelte-basic',
		label: 'Svelte 5 + CSS (local-only)',
		description: 'Svelte stores — no sync server',
	},
	{
		name: 'svelte-tailwind-sync',
		label: 'Svelte 5 + Tailwind (with sync)',
		description: 'Polished Svelte app with Tailwind CSS and sync server',
	},
	{
		name: 'svelte-tailwind',
		label: 'Svelte 5 + Tailwind (local-only)',
		description: 'Polished Svelte app with Tailwind CSS — no sync server',
	},
	{
		name: 'tauri-react',
		label: 'Tauri Desktop (native SQLite)',
		description: 'Desktop app with native SQLite — no WASM, includes sync server',
	},
] as const

/** Variables available for template substitution */
export interface TemplateContext {
	projectName: string
	packageManager: PackageManager
	koraVersion: string
	dbProvider?: string
}
