/** Supported package managers */
export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

/** Available project templates */
export const TEMPLATES = ['react-basic', 'react-sync'] as const
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
		name: 'react-basic',
		label: 'React (basic)',
		description: 'Local-only React app with Kora — no sync server',
	},
	{
		name: 'react-sync',
		label: 'React (with sync)',
		description: 'React app with Kora sync server included',
	},
] as const

/** Variables available for template substitution */
export interface TemplateContext {
	projectName: string
	packageManager: PackageManager
	koraVersion: string
}
