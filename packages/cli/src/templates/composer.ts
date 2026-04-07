import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TemplateContext, TemplateName } from '../types'

export type TemplateLayerCategory = 'base' | 'ui' | 'style' | 'sync' | 'db' | 'auth'

export interface TemplateLayer {
	category: TemplateLayerCategory
	name: string
	sourceTemplate: TemplateName | null
}

export interface TemplateLayerPlan {
	layers: readonly TemplateLayer[]
	compatibilityTarget: TemplateName
}

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
 * In source, it's src/templates/composer.ts (2 levels from root).
 * We walk up from the current file to find the package root containing templates/.
 *
 * @param templateName - Name of the template (for example, 'react-basic')
 * @returns Absolute path to the template directory
 */
export function getTemplatePath(templateName: TemplateName): string {
	let dir = dirname(fileURLToPath(import.meta.url))
	for (let i = 0; i < 7; i++) {
		const candidate = resolve(dir, 'templates', templateName)
		if (existsSync(candidate)) {
			return candidate
		}
		dir = dirname(dir)
	}
	// Fallback: assume bundled output and step to package root.
	const currentDir = dirname(fileURLToPath(import.meta.url))
	return resolve(currentDir, '..', '..', '..', 'templates', templateName)
}

/**
 * Returns a v1 compatibility layer plan that composes to one of the existing
 * four concrete templates. This establishes the layer architecture while
 * preserving byte-for-byte output compatibility for current templates.
 */
export function createCompatibilityLayerPlan(templateName: TemplateName): TemplateLayerPlan {
	const baseLayer: TemplateLayer = { category: 'base', name: 'base', sourceTemplate: 'react-basic' }
	const uiLayer: TemplateLayer = { category: 'ui', name: 'react', sourceTemplate: null }
	const authLayer: TemplateLayer = { category: 'auth', name: 'none', sourceTemplate: null }

	switch (templateName) {
		case 'react-basic':
			return {
				compatibilityTarget: templateName,
				layers: [
					baseLayer,
					uiLayer,
					{ category: 'style', name: 'plain', sourceTemplate: null },
					{ category: 'sync', name: 'disabled', sourceTemplate: null },
					{ category: 'db', name: 'none', sourceTemplate: null },
					authLayer,
				],
			}
		case 'react-tailwind':
			return {
				compatibilityTarget: templateName,
				layers: [
					baseLayer,
					uiLayer,
					{ category: 'style', name: 'tailwind', sourceTemplate: 'react-tailwind' },
					{ category: 'sync', name: 'disabled', sourceTemplate: null },
					{ category: 'db', name: 'none', sourceTemplate: null },
					authLayer,
				],
			}
		case 'react-sync':
			return {
				compatibilityTarget: templateName,
				layers: [
					baseLayer,
					uiLayer,
					{ category: 'style', name: 'plain', sourceTemplate: null },
					{ category: 'sync', name: 'enabled', sourceTemplate: 'react-sync' },
					{ category: 'db', name: 'sqlite', sourceTemplate: null },
					authLayer,
				],
			}
		case 'react-tailwind-sync':
			return {
				compatibilityTarget: templateName,
				layers: [
					baseLayer,
					uiLayer,
					{ category: 'style', name: 'tailwind', sourceTemplate: 'react-tailwind' },
					{ category: 'sync', name: 'enabled', sourceTemplate: 'react-tailwind-sync' },
					{ category: 'db', name: 'sqlite', sourceTemplate: null },
					authLayer,
				],
			}
	}
}

/**
 * Composes a project by applying template layers in order. Later layers
 * overwrite earlier files, which allows progressive specialization.
 *
 * @param plan - Layer plan describing the composition
 * @param targetDir - Destination directory (must not exist yet)
 * @param context - Variables for template substitution
 */
export async function composeTemplateLayers(
	plan: TemplateLayerPlan,
	targetDir: string,
	context: TemplateContext,
): Promise<void> {
	const vars: Record<string, string> = {
		projectName: context.projectName,
		packageManager: context.packageManager,
		koraVersion: context.koraVersion,
		dbProvider: context.dbProvider ?? 'none',
	}

	for (const layer of plan.layers) {
		if (layer.sourceTemplate === null) {
			continue
		}
		const sourceDir = getTemplatePath(layer.sourceTemplate)
		await copyDirectory(sourceDir, targetDir, vars)
	}
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
			continue
		}
		if (entry.endsWith('.hbs')) {
			const content = await readFile(srcPath, 'utf-8')
			const outputName = entry.slice(0, -4)
			await writeFile(join(dest, outputName), substituteVariables(content, vars), 'utf-8')
			continue
		}
		await copyFile(srcPath, join(dest, entry))
	}
}
