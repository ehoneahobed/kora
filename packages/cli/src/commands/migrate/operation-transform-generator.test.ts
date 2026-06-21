import { describe, expect, test } from 'vitest'
import { generateOperationTransformModule } from './operation-transform-generator'

describe('generateOperationTransformModule', () => {
	test('emits OperationTransform stub for version range', () => {
		const source = generateOperationTransformModule(1, 2)
		expect(source).toContain('fromVersion: 1')
		expect(source).toContain('toVersion: 2')
		expect(source).toContain("import type { Operation, OperationTransform } from '@korajs/core'")
		expect(source).toContain('export const operationTransforms')
	})
})
