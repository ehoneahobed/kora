import { describe, expect, test } from 'vitest'
import { OperationError } from '../errors/errors'
import { deriveSideEffectOpId } from './side-effect-id'

describe('deriveSideEffectOpId', () => {
	test('is deterministic: every replica derives the same id', async () => {
		const a = await deriveSideEffectOpId('parent', 'relation:todoProject:cascade', 'todo-1')
		const b = await deriveSideEffectOpId('parent', 'relation:todoProject:cascade', 'todo-1')
		expect(a).toBe(b)
		expect(a).toMatch(/^[0-9a-f]{64}$/)
	})

	test('differs by parent, rule and target', async () => {
		const base = await deriveSideEffectOpId('p', 'r', 't')
		expect(await deriveSideEffectOpId('p2', 'r', 't')).not.toBe(base)
		expect(await deriveSideEffectOpId('p', 'r2', 't')).not.toBe(base)
		expect(await deriveSideEffectOpId('p', 'r', 't2')).not.toBe(base)
	})

	test('is unambiguous across component boundaries', async () => {
		expect(await deriveSideEffectOpId('ab', 'c', 't')).not.toBe(
			await deriveSideEffectOpId('a', 'bc', 't'),
		)
	})

	test('rejects empty components', async () => {
		await expect(deriveSideEffectOpId('', 'r', 't')).rejects.toBeInstanceOf(OperationError)
		await expect(deriveSideEffectOpId('p', '', 't')).rejects.toBeInstanceOf(OperationError)
		await expect(deriveSideEffectOpId('p', 'r', '')).rejects.toBeInstanceOf(OperationError)
	})
})
