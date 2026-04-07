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
export { validateProjectName, type ProjectNameValidationResult } from './commands/create/project-name'
export {
	determineTemplateFromSelections,
	isAuthValue,
	isDatabaseProviderValue,
	isDatabaseValue,
	isFrameworkValue,
	type AuthOption,
	type DatabaseOption,
	type DatabaseProviderOption,
	type FrameworkOption,
	type TemplateSelectionInput,
} from './commands/create/options'
export {
	resolveCreatePreferencesFlow,
	saveResolvedPreferences,
	shouldSavePreferences,
	type CreateFlags,
	type PreferenceResolutionResult,
} from './commands/create/preferences-flow'
export { applySyncProviderPreset } from './commands/create/sync-provider-preset'

// === Prompt Abstractions ===
export {
	createPromptClient,
	ClackPromptClient,
	ReadlinePromptClient,
	PromptCancelledError,
	type PromptClient,
	type SelectOption,
} from './prompts/prompt-client'
export {
	getDefaultCreatePreferences,
	getCreatePreferencesOrDefault,
	PreferenceStore,
	type CreatePreferences,
} from './prompts/preferences'
