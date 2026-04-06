/** Supported package managers */
export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

/** Available project templates */
export const TEMPLATES = [
	'react-tailwind-sync',
	'react-tailwind',
	'react-sync',
	'react-basic',
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
] as const

/** Variables available for template substitution */
export interface TemplateContext {
	projectName: string
	packageManager: PackageManager
	koraVersion: string
}
