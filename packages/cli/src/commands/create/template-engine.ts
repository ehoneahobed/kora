import { composeTemplateLayers, createCompatibilityLayerPlan } from '../../templates/composer'
import { writeGitignore } from '../../templates/gitignore'
import type { TemplateContext, TemplateName } from '../../types'

// The template helpers live in templates/composer; re-exported for the create command's callers.
export { substituteVariables, getTemplatePath } from '../../templates/composer'

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
	const plan = createCompatibilityLayerPlan(templateName)
	await composeTemplateLayers(plan, targetDir, context)
	await writeGitignore(targetDir, { tauri: templateName.startsWith('tauri') })
}
