import { describe, expect, test } from 'vitest'
import {
	emailHint,
	hashToken,
	invitationIdFor,
	invitationIdOfToken,
	newInvitationToken,
	normalizeEmail,
	tokenMatches,
} from './tokens'

describe('invitation tokens', () => {
	test('a token names its invitation and matches only its own hash', () => {
		const id = invitationIdFor('forms:f1', 'bob@example.com')
		const token = newInvitationToken(id)
		expect(invitationIdOfToken(token)).toBe(id)
		expect(tokenMatches(token, hashToken(token))).toBe(true)
		expect(tokenMatches(newInvitationToken(id), hashToken(token))).toBe(false)
		expect(tokenMatches(token, 'not-a-hash')).toBe(false)
	})

	test('malformed tokens name nothing', () => {
		for (const bad of [
			null,
			42,
			'',
			'abc',
			'inv_123.abc',
			`inv_${'g'.repeat(32)}.${'A'.repeat(43)}`,
			'x'.repeat(500),
		]) {
			expect(invitationIdOfToken(bad)).toBeNull()
		}
	})

	test('one invitation per address and space, whatever the case and spaces', () => {
		expect(invitationIdFor('forms:f1', normalizeEmail(' Bob@Example.COM '))).toBe(
			invitationIdFor('forms:f1', 'bob@example.com'),
		)
		expect(invitationIdFor('forms:f2', 'bob@example.com')).not.toBe(
			invitationIdFor('forms:f1', 'bob@example.com'),
		)
	})

	test('the hint keeps the first letter and the domain', () => {
		expect(emailHint('jane@example.com')).toBe('j***@example.com')
		expect(emailHint('nope')).toBe('***')
	})
})
