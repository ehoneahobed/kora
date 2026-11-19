import { KoraError } from '@korajs/core'

/**
 * Thrown by `createProductionServer` for an option it cannot use: the message and
 * `context.fix` say which option, what it was given, and what it accepts.
 */
export class InvalidServerConfigError extends KoraError {
	constructor(option: string, value: unknown, expected: string) {
		super(
			`createProductionServer: ${option} must be ${expected}, got ${typeof value === 'string' ? JSON.stringify(value) : String(value)}.`,
			'INVALID_SERVER_CONFIG',
			{ option, value, fix: `Pass ${option} as ${expected}, or leave it out for the default.` },
		)
		this.name = 'InvalidServerConfigError'
	}
}
