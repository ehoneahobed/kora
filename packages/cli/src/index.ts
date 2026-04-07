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
export { deployCommand } from './commands/deploy/deploy-command'
export {
	DEPLOY_PLATFORMS,
	isDeployPlatform,
	type DeployAdapter,
	type BuildArtifacts,
	type DeployPlatform,
	type DeployResult,
	type DeploymentStatus,
	type LogLine,
	type LogOptions,
	type ProjectConfig,
	type ProvisionResult,
} from './commands/deploy/adapters/adapter'
export {
	readDeployState,
	resetDeployState,
	resolveDeployDirectory,
	resolveDeployStatePath,
	updateDeployState,
	writeDeployState,
	type DeployState,
	type DeployStateCreateInput,
	type DeployStatePatch,
} from './commands/deploy/state/deploy-state'
export {
	generateDockerIgnore,
	generateDockerfile,
	writeDockerIgnoreArtifact,
	writeDockerfileArtifact,
	type DockerfileOptions,
} from './commands/deploy/artifacts/dockerfile-generator'
export {
	generateFlyToml,
	writeFlyTomlArtifact,
	type FlyTomlOptions,
} from './commands/deploy/artifacts/fly-toml-generator'
export {
	buildClient,
	type ClientBuildOptions,
	type ClientBuildResult,
} from './commands/deploy/builder/client-builder'
export {
	bundleServer,
	type ServerBundleOptions,
	type ServerBundleResult,
} from './commands/deploy/builder/server-bundler'
export {
	validateProjectName,
	type ProjectNameValidationResult,
} from './commands/create/project-name'
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
