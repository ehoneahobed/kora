import { describe, expect, test } from 'vitest'
import { pluralize, singularize } from './pluralize'

describe('pluralize', () => {
	test('adds s to regular words', () => {
		expect(pluralize('project')).toBe('projects')
		expect(pluralize('todo')).toBe('todos')
		expect(pluralize('user')).toBe('users')
	})

	test('converts y to ies for consonant+y', () => {
		expect(pluralize('category')).toBe('categories')
		expect(pluralize('company')).toBe('companies')
	})

	test('keeps y for vowel+y', () => {
		expect(pluralize('key')).toBe('keys')
		expect(pluralize('day')).toBe('days')
	})

	test('adds es for sh, ch, x, z endings', () => {
		expect(pluralize('match')).toBe('matches')
		expect(pluralize('box')).toBe('boxes')
		expect(pluralize('wish')).toBe('wishes')
		expect(pluralize('buzz')).toBe('buzzes')
	})

	test('returns already-plural words unchanged', () => {
		expect(pluralize('todos')).toBe('todos')
		expect(pluralize('users')).toBe('users')
	})
})

describe('singularize', () => {
	test('removes s from regular words', () => {
		expect(singularize('projects')).toBe('project')
		expect(singularize('todos')).toBe('todo')
		expect(singularize('users')).toBe('user')
	})

	test('converts ies to y for consonant+ies', () => {
		expect(singularize('categories')).toBe('category')
		expect(singularize('companies')).toBe('company')
	})

	test('removes es from ches, xes, shes, zes, ses endings', () => {
		expect(singularize('matches')).toBe('match')
		expect(singularize('boxes')).toBe('box')
		expect(singularize('wishes')).toBe('wish')
		expect(singularize('buzzes')).toBe('buzz')
	})

	test('preserves words ending in ss', () => {
		expect(singularize('class')).toBe('class')
		expect(singularize('boss')).toBe('boss')
	})

	test('returns already-singular words unchanged', () => {
		expect(singularize('project')).toBe('project')
		expect(singularize('todo')).toBe('todo')
	})
})
