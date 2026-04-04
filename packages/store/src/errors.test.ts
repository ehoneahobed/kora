import { KoraError } from '@kora/core'
import { describe, expect, test } from 'vitest'
import { AdapterError, QueryError, RecordNotFoundError, StoreNotOpenError } from './errors'

describe('QueryError', () => {
	test('extends KoraError with QUERY_ERROR code', () => {
		const error = new QueryError('Invalid field')
		expect(error).toBeInstanceOf(KoraError)
		expect(error.code).toBe('QUERY_ERROR')
		expect(error.name).toBe('QueryError')
		expect(error.message).toBe('Invalid field')
	})

	test('includes context when provided', () => {
		const error = new QueryError('Bad operator', { field: 'title', operator: '$regex' })
		expect(error.context).toEqual({ field: 'title', operator: '$regex' })
	})

	test('context is undefined when not provided', () => {
		const error = new QueryError('some error')
		expect(error.context).toBeUndefined()
	})
})

describe('RecordNotFoundError', () => {
	test('extends KoraError with RECORD_NOT_FOUND code', () => {
		const error = new RecordNotFoundError('todos', 'abc-123')
		expect(error).toBeInstanceOf(KoraError)
		expect(error.code).toBe('RECORD_NOT_FOUND')
		expect(error.name).toBe('RecordNotFoundError')
	})

	test('produces descriptive message with collection and id', () => {
		const error = new RecordNotFoundError('todos', 'abc-123')
		expect(error.message).toBe('Record "abc-123" not found in collection "todos"')
	})

	test('includes collection and recordId in context', () => {
		const error = new RecordNotFoundError('projects', 'xyz-789')
		expect(error.context).toEqual({ collection: 'projects', recordId: 'xyz-789' })
	})
})

describe('AdapterError', () => {
	test('extends KoraError with ADAPTER_ERROR code', () => {
		const error = new AdapterError('Connection failed')
		expect(error).toBeInstanceOf(KoraError)
		expect(error.code).toBe('ADAPTER_ERROR')
		expect(error.name).toBe('AdapterError')
		expect(error.message).toBe('Connection failed')
	})

	test('includes context when provided', () => {
		const error = new AdapterError('Query failed', { sql: 'SELECT *' })
		expect(error.context).toEqual({ sql: 'SELECT *' })
	})
})

describe('StoreNotOpenError', () => {
	test('extends KoraError with STORE_NOT_OPEN code', () => {
		const error = new StoreNotOpenError()
		expect(error).toBeInstanceOf(KoraError)
		expect(error.code).toBe('STORE_NOT_OPEN')
		expect(error.name).toBe('StoreNotOpenError')
	})

	test('has a helpful message', () => {
		const error = new StoreNotOpenError()
		expect(error.message).toContain('store.open()')
	})
})
