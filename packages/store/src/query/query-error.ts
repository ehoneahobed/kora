import { KoraError } from '@korajs/core/lite'

/**
 * Thrown when a query is invalid (bad field names, invalid operators, etc.).
 */
export class QueryError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'QUERY_ERROR', context)
		this.name = 'QueryError'
	}
}
