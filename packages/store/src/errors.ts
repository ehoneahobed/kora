import { KoraError } from '@kora/core'

/**
 * Thrown when a query is invalid (bad field names, invalid operators, etc.).
 */
export class QueryError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'QUERY_ERROR', context)
		this.name = 'QueryError'
	}
}

/**
 * Thrown when a record is not found by ID (findById, update, delete on missing record).
 */
export class RecordNotFoundError extends KoraError {
	constructor(collection: string, recordId: string) {
		super(`Record "${recordId}" not found in collection "${collection}"`, 'RECORD_NOT_FOUND', {
			collection,
			recordId,
		})
		this.name = 'RecordNotFoundError'
	}
}

/**
 * Thrown when a storage adapter operation fails.
 */
export class AdapterError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'ADAPTER_ERROR', context)
		this.name = 'AdapterError'
	}
}

/**
 * Thrown when an operation is attempted on a store that has not been opened.
 */
export class StoreNotOpenError extends KoraError {
	constructor() {
		super('Store is not open. Call store.open() before performing operations.', 'STORE_NOT_OPEN')
		this.name = 'StoreNotOpenError'
	}
}
