// @korajs/cli — public API
// Every export here is a public API commitment. Be explicit.

// === Types ===
export type { PackageManager, TemplateName, TemplateContext, TemplateInfo } from './types'
export { PACKAGE_MANAGERS, TEMPLATES, TEMPLATE_INFO } from './types'

// === Errors ===
export {
	CliError,
	DevServerError,
	InvalidProjectError,
	ProjectExistsError,
	SchemaNotFoundError,
} from './errors'

// === Type Generation (programmatic use) ===
export { generateTypes } from './commands/generate/type-generator'
