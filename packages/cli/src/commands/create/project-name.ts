import validateNpmPackageName from 'validate-npm-package-name'

export interface ProjectNameValidationResult {
	valid: boolean
	issues: readonly string[]
}

/**
 * Validates a project name for scaffolded package creation.
 *
 * The create command uses this validation before writing files so users get a
 * clear, early error if the name cannot be used as an npm package name.
 */
export function validateProjectName(name: string): ProjectNameValidationResult {
	const trimmedName = name.trim()
	if (trimmedName.length === 0) {
		return {
			valid: false,
			issues: ['Project name cannot be empty.'],
		}
	}

	const validation = validateNpmPackageName(trimmedName)
	const issues = [...(validation.errors ?? []), ...(validation.warnings ?? [])]
	if (!validation.validForNewPackages && issues.length === 0) {
		return {
			valid: false,
			issues: ['Project name is not a valid npm package name.'],
		}
	}

	return {
		valid: validation.validForNewPackages,
		issues,
	}
}
