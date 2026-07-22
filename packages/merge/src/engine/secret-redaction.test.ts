import type { FieldDescriptor, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { mergeField } from './field-merger'

function op(overrides: Partial<Operation>): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'node-a',
		type: 'update',
		collection: 'users',
		recordId: 'rec-1',
		data: {},
		previousData: {},
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

const secretDescriptor: FieldDescriptor = {
	kind: 'secret',
	required: true,
	defaultValue: undefined,
	auto: false,
	enumValues: null,
	itemKind: null,
	mergeStrategy: null,
	transitions: null,
	secretMode: 'encrypted',
}

const stringDescriptor: FieldDescriptor = { ...secretDescriptor, kind: 'string', secretMode: null }

describe('secret field trace redaction', () => {
	test('a conflicting secret merge redacts every value in the trace', () => {
		const local = op({
			data: { apiKey: 'ciphertext-from-A' },
			previousData: { apiKey: 'ciphertext-base' },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
		})
		const remote = op({
			data: { apiKey: 'ciphertext-from-B' },
			previousData: { apiKey: 'ciphertext-base' },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
		})
		const base = { apiKey: 'ciphertext-base' }

		const result = mergeField('apiKey', local, remote, base, secretDescriptor)

		// The merge still resolves correctly (local is later → wins).
		expect(result.value).toBe('ciphertext-from-A')

		// But no secret value appears anywhere in the trace.
		expect(result.trace.inputA).toBe('[secret]')
		expect(result.trace.inputB).toBe('[secret]')
		expect(result.trace.base).toBe('[secret]')
		expect(result.trace.output).toBe('[secret]')
		const serialized = JSON.stringify(result.trace)
		expect(serialized).not.toContain('ciphertext-from-A')
		expect(serialized).not.toContain('ciphertext-from-B')
		expect(serialized).not.toContain('ciphertext-base')
	})

	test('a non-conflict secret merge (only one side changed) also redacts', () => {
		const local = op({ data: { apiKey: 'only-A-changed' }, previousData: {} })
		const remote = op({ data: {}, previousData: {} })
		const result = mergeField('apiKey', local, remote, {}, secretDescriptor)
		expect(result.trace.inputA).toBe('[secret]')
		expect(result.trace.output).toBe('[secret]')
		expect(JSON.stringify(result.trace)).not.toContain('only-A-changed')
	})

	test('a null base stays null after redaction (not the sentinel)', () => {
		const local = op({ data: { apiKey: 'a' }, previousData: {} })
		const remote = op({ data: { apiKey: 'b' }, previousData: {} })
		// base has no value for apiKey → trace.base is nullish (no value to hide)
		const result = mergeField('apiKey', local, remote, {}, secretDescriptor)
		expect(result.trace.base == null).toBe(true)
	})

	test('non-secret fields are NOT redacted (values remain visible for DevTools)', () => {
		const local = op({
			data: { name: 'Alice' },
			previousData: { name: 'base' },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
		})
		const remote = op({
			data: { name: 'Bob' },
			previousData: { name: 'base' },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
		})
		const result = mergeField('name', local, remote, { name: 'base' }, stringDescriptor)
		expect(result.trace.inputA).toBe('Alice')
		expect(result.trace.inputB).toBe('Bob')
	})
})
