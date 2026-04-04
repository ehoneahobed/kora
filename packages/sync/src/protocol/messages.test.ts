import { describe, expect, test } from 'vitest'
import type {
	AcknowledgmentMessage,
	ErrorMessage,
	HandshakeMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
	SerializedOperation,
} from './messages'
import {
	isAcknowledgmentMessage,
	isErrorMessage,
	isHandshakeMessage,
	isHandshakeResponseMessage,
	isOperationBatchMessage,
	isSyncMessage,
} from './messages'

function makeSerializedOp(overrides?: Partial<SerializedOperation>): SerializedOperation {
	return {
		id: 'op-1',
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'Test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('isHandshakeMessage', () => {
	const valid: HandshakeMessage = {
		type: 'handshake',
		messageId: 'msg-1',
		nodeId: 'node-1',
		versionVector: { 'node-1': 5 },
		schemaVersion: 1,
	}

	test('accepts a valid handshake message', () => {
		expect(isHandshakeMessage(valid)).toBe(true)
	})

	test('accepts handshake with optional authToken', () => {
		expect(isHandshakeMessage({ ...valid, authToken: 'token-123' })).toBe(true)
	})

	test('rejects null', () => {
		expect(isHandshakeMessage(null)).toBe(false)
	})

	test('rejects wrong type field', () => {
		expect(isHandshakeMessage({ ...valid, type: 'error' })).toBe(false)
	})

	test('rejects missing messageId', () => {
		const { messageId: _, ...rest } = valid
		expect(isHandshakeMessage(rest)).toBe(false)
	})

	test('rejects missing nodeId', () => {
		const { nodeId: _, ...rest } = valid
		expect(isHandshakeMessage(rest)).toBe(false)
	})

	test('rejects array versionVector', () => {
		expect(isHandshakeMessage({ ...valid, versionVector: [1, 2] })).toBe(false)
	})

	test('rejects null versionVector', () => {
		expect(isHandshakeMessage({ ...valid, versionVector: null })).toBe(false)
	})

	test('rejects missing schemaVersion', () => {
		const { schemaVersion: _, ...rest } = valid
		expect(isHandshakeMessage(rest)).toBe(false)
	})
})

describe('isHandshakeResponseMessage', () => {
	const valid: HandshakeResponseMessage = {
		type: 'handshake-response',
		messageId: 'msg-2',
		nodeId: 'server-1',
		versionVector: { 'node-1': 5, 'node-2': 3 },
		schemaVersion: 1,
		accepted: true,
	}

	test('accepts a valid handshake response', () => {
		expect(isHandshakeResponseMessage(valid)).toBe(true)
	})

	test('accepts rejected response with reason', () => {
		expect(
			isHandshakeResponseMessage({
				...valid,
				accepted: false,
				rejectReason: 'Schema mismatch',
			}),
		).toBe(true)
	})

	test('rejects missing accepted field', () => {
		const { accepted: _, ...rest } = valid
		expect(isHandshakeResponseMessage(rest)).toBe(false)
	})

	test('rejects wrong type', () => {
		expect(isHandshakeResponseMessage({ ...valid, type: 'handshake' })).toBe(false)
	})
})

describe('isOperationBatchMessage', () => {
	const valid: OperationBatchMessage = {
		type: 'operation-batch',
		messageId: 'msg-3',
		operations: [makeSerializedOp()],
		isFinal: true,
		batchIndex: 0,
	}

	test('accepts a valid operation batch', () => {
		expect(isOperationBatchMessage(valid)).toBe(true)
	})

	test('accepts empty operations array', () => {
		expect(isOperationBatchMessage({ ...valid, operations: [] })).toBe(true)
	})

	test('rejects non-array operations', () => {
		expect(isOperationBatchMessage({ ...valid, operations: 'not-array' })).toBe(false)
	})

	test('rejects missing isFinal', () => {
		const { isFinal: _, ...rest } = valid
		expect(isOperationBatchMessage(rest)).toBe(false)
	})

	test('rejects missing batchIndex', () => {
		const { batchIndex: _, ...rest } = valid
		expect(isOperationBatchMessage(rest)).toBe(false)
	})
})

describe('isAcknowledgmentMessage', () => {
	const valid: AcknowledgmentMessage = {
		type: 'acknowledgment',
		messageId: 'msg-4',
		acknowledgedMessageId: 'msg-3',
		lastSequenceNumber: 10,
	}

	test('accepts a valid acknowledgment', () => {
		expect(isAcknowledgmentMessage(valid)).toBe(true)
	})

	test('rejects missing acknowledgedMessageId', () => {
		const { acknowledgedMessageId: _, ...rest } = valid
		expect(isAcknowledgmentMessage(rest)).toBe(false)
	})

	test('rejects missing lastSequenceNumber', () => {
		const { lastSequenceNumber: _, ...rest } = valid
		expect(isAcknowledgmentMessage(rest)).toBe(false)
	})
})

describe('isErrorMessage', () => {
	const valid: ErrorMessage = {
		type: 'error',
		messageId: 'msg-5',
		code: 'AUTH_FAILED',
		message: 'Invalid token',
		retriable: false,
	}

	test('accepts a valid error message', () => {
		expect(isErrorMessage(valid)).toBe(true)
	})

	test('rejects missing code', () => {
		const { code: _, ...rest } = valid
		expect(isErrorMessage(rest)).toBe(false)
	})

	test('rejects missing retriable', () => {
		const { retriable: _, ...rest } = valid
		expect(isErrorMessage(rest)).toBe(false)
	})
})

describe('isSyncMessage', () => {
	test('accepts all valid message types', () => {
		const handshake: HandshakeMessage = {
			type: 'handshake',
			messageId: 'm1',
			nodeId: 'n1',
			versionVector: {},
			schemaVersion: 1,
		}
		const response: HandshakeResponseMessage = {
			type: 'handshake-response',
			messageId: 'm2',
			nodeId: 'n2',
			versionVector: {},
			schemaVersion: 1,
			accepted: true,
		}
		const batch: OperationBatchMessage = {
			type: 'operation-batch',
			messageId: 'm3',
			operations: [],
			isFinal: true,
			batchIndex: 0,
		}
		const ack: AcknowledgmentMessage = {
			type: 'acknowledgment',
			messageId: 'm4',
			acknowledgedMessageId: 'm3',
			lastSequenceNumber: 1,
		}
		const error: ErrorMessage = {
			type: 'error',
			messageId: 'm5',
			code: 'ERR',
			message: 'fail',
			retriable: false,
		}

		expect(isSyncMessage(handshake)).toBe(true)
		expect(isSyncMessage(response)).toBe(true)
		expect(isSyncMessage(batch)).toBe(true)
		expect(isSyncMessage(ack)).toBe(true)
		expect(isSyncMessage(error)).toBe(true)
	})

	test('rejects primitives', () => {
		expect(isSyncMessage(null)).toBe(false)
		expect(isSyncMessage(undefined)).toBe(false)
		expect(isSyncMessage(42)).toBe(false)
		expect(isSyncMessage('string')).toBe(false)
	})

	test('rejects unknown type', () => {
		expect(isSyncMessage({ type: 'unknown', messageId: 'x' })).toBe(false)
	})

	test('rejects missing messageId', () => {
		expect(isSyncMessage({ type: 'handshake' })).toBe(false)
	})

	test('rejects object without type', () => {
		expect(isSyncMessage({ messageId: 'x' })).toBe(false)
	})
})
