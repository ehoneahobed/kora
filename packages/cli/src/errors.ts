import { KoraError } from '@kora/core'

/**
 * Base error class for all CLI errors.
 */
export class CliError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'CLI_ERROR', context)
		this.name = 'CliError'
	}
}

/**
 * Thrown when the target project directory already exists.
 */
export class ProjectExistsError extends KoraError {
	constructor(public readonly directory: string) {
		super(
			`Directory "${directory}" already exists. Choose a different name or remove the existing directory.`,
			'PROJECT_EXISTS',
			{ directory },
		)
		this.name = 'ProjectExistsError'
	}
}

/**
 * Thrown when a schema file cannot be found in the project.
 */
export class SchemaNotFoundError extends KoraError {
	constructor(public readonly searchedPaths: string[]) {
		super(
			`Could not find a schema file. Searched: ${searchedPaths.join(', ')}. Create a schema file using defineSchema() from @kora/core.`,
			'SCHEMA_NOT_FOUND',
			{ searchedPaths },
		)
		this.name = 'SchemaNotFoundError'
	}
}

/**
 * Thrown when a command is run outside a valid Kora project.
 */
export class InvalidProjectError extends KoraError {
	constructor(public readonly directory: string) {
		super(
			`"${directory}" is not a valid Kora project. No package.json with a kora dependency found. Run this command from inside a Kora project.`,
			'INVALID_PROJECT',
			{ directory },
		)
		this.name = 'InvalidProjectError'
	}
}

/**
 * Thrown when a required local dev server binary cannot be found.
 */
export class DevServerError extends KoraError {
	constructor(
		public readonly binary: string,
		public readonly searchPath: string,
	) {
		super(
			`Could not find required binary "${binary}" at ${searchPath}. Install project dependencies and try again.`,
			'DEV_SERVER_ERROR',
			{ binary, searchPath },
		)
		this.name = 'DevServerError'
	}
}
