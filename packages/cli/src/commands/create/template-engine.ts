import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TemplateContext, TemplateName } from '../../types'

/**
 * Replaces {{variable}} placeholders in a template string with context values.
 *
 * @param template - The template string containing {{variable}} placeholders
 * @param context - Key-value pairs to substitute
 * @returns The template with all placeholders replaced
 */
export function substituteVariables(template: string, context: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
		const value = context[key]
		return value !== undefined ? value : `{{${key}}}`
	})
}

/**
 * Resolves the absolute path to a bundled template directory.
 *
 * After tsup bundling, import.meta.url points to dist/<file>.js (1 level from root).
 * In source, it's src/commands/create/template-engine.ts (3 levels from root).
 * We walk up from the current file to find the package root containing templates/.
 *
 * @param templateName - Name of the template (e.g. 'react-basic')
 * @returns Absolute path to the template directory
 */
export function getTemplatePath(templateName: TemplateName): string {
	let dir = dirname(fileURLToPath(import.meta.url))
	for (let i = 0; i < 5; i++) {
		if (existsSync(resolve(dir, 'templates'))) {
			return resolve(dir, 'templates', templateName)
		}
		dir = dirname(dir)
	}
	// Fallback: assume bundled (1 level from package root)
	const currentDir = dirname(fileURLToPath(import.meta.url))
	return resolve(currentDir, '..', 'templates', templateName)
}

/**
 * Scaffolds a project from a bundled template.
 * Copies all files from the template directory to the target, applying
 * variable substitution to .hbs files and stripping the .hbs extension.
 *
 * @param templateName - Which template to use
 * @param targetDir - Destination directory (must not exist yet)
 * @param context - Variables for template substitution
 */
export async function scaffoldTemplate(
	templateName: TemplateName,
	targetDir: string,
	context: TemplateContext,
): Promise<void> {
	const templateDir = getTemplatePath(templateName)
	const vars: Record<string, string> = {
		projectName: context.projectName,
		packageManager: context.packageManager,
		koraVersion: context.koraVersion,
	}
	await copyDirectory(templateDir, targetDir, vars)
}

async function copyDirectory(
	src: string,
	dest: string,
	vars: Record<string, string>,
): Promise<void> {
	await mkdir(dest, { recursive: true })
	const entries = await readdir(src)

	for (const entry of entries) {
		const srcPath = join(src, entry)
		const srcStat = await stat(srcPath)

		if (srcStat.isDirectory()) {
			await copyDirectory(srcPath, join(dest, entry), vars)
		} else if (entry.endsWith('.hbs')) {
			// Template file: substitute variables and strip .hbs extension
			const content = await readFile(srcPath, 'utf-8')
			const outputName = entry.slice(0, -4) // Remove .hbs
			await writeFile(join(dest, outputName), substituteVariables(content, vars), 'utf-8')
		} else {
			// Regular file: copy as-is
			await copyFile(srcPath, join(dest, entry))
		}
	}
}
