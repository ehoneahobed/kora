import { composeTemplateLayers, createCompatibilityLayerPlan } from '../../templates/composer'
import type { TemplateContext, TemplateName } from '../../types'

/**
 * Replaces {{variable}} placeholders in a template string with context values.
 *
 * @param template - The template string containing {{variable}} placeholders
 * @param context - Key-value pairs to substitute
 * @returns The template with all placeholders replaced
 */
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
}
