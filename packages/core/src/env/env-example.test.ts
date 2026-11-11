import { describe, expect, test } from 'vitest'
import { missingRequiredEnv, parseEnvExample } from './env-example'

describe('parseEnvExample', () => {
	test('a comment block describes the variables right below it, and tags set the rules', () => {
		const declared = parseEnvExample(`# Operational endpoints
# [secret] Bearer tokens for /__kora routes.
KORA_ADMIN_TOKEN=
KORA_METRICS_TOKEN=

# [required] [secret] Sends invitation and verification emails.
RESEND_API_KEY=

# [development] Where emails go outside production.
DEV_MAILBOX=./mail # not sent
EMAIL_FROM="Acme <hi@acme.dev>"
PORT=3001
`)
		expect(
			declared.map((entry) => [entry.name, entry.required, entry.secret, entry.developmentOnly]),
		).toEqual([
			['KORA_ADMIN_TOKEN', false, true, false],
			['KORA_METRICS_TOKEN', false, true, false],
			['RESEND_API_KEY', true, true, false],
			['DEV_MAILBOX', false, false, true],
			['EMAIL_FROM', false, false, true],
			['PORT', false, false, true],
		])
		expect(declared[0]?.description).toBe('Operational endpoints Bearer tokens for /__kora routes.')
		expect(declared[2]?.description).toBe('Sends invitation and verification emails.')
		expect(declared[3]?.example).toBe('./mail')
		expect(declared[4]?.example).toBe('Acme <hi@acme.dev>')
	})

	test('a comment after variables starts a new group, and untagged files still parse', () => {
		const declared = parseEnvExample('A=1\n# [required] For B\nB=\nnot a line\nexport C=3\n')
		expect(declared.map((entry) => [entry.name, entry.required, entry.description])).toEqual([
			['A', false, null],
			['B', true, 'For B'],
			['C', true, 'For B'],
		])
	})

	test('[development] wins over [required], and a repeated name keeps its first entry', () => {
		const declared = parseEnvExample('# [required] [development]\nX=\n\n# [required]\nX=\n')
		expect(declared).toHaveLength(1)
		expect(declared[0]?.required).toBe(false)
	})
})

test('missingRequiredEnv lists required settings that are unset or blank', () => {
	const declared = parseEnvExample('# [required]\nA=\nB=\n\n# [required]\nC=\n')
	expect(missingRequiredEnv(declared, { A: 'set', B: '  ' }).map((entry) => entry.name)).toEqual([
		'B',
		'C',
	])
})
