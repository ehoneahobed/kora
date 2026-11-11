import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { checkDeclaredSettings } from './settings-check'

test('production fails on a missing required setting, naming it and what it is for', async () => {
	const root = await mkdtemp(join(tmpdir(), 'kora-settings-'))
	await writeFile(
		join(root, '.env.example'),
		'# [required] [secret] Sends invitation emails.\nRESEND_API_KEY=\n\n# [development]\nDEV_MAILBOX=\n',
	)
	const missing = await checkDeclaredSettings(root, {}, true)
	expect(missing.status).toBe('fail')
	expect(missing.message).toContain('RESEND_API_KEY (Sends invitation emails.)')
	expect(missing.message).not.toContain('DEV_MAILBOX')
	expect((await checkDeclaredSettings(root, { RESEND_API_KEY: 're_x' }, true)).status).toBe('pass')
	expect((await checkDeclaredSettings(root, {}, false)).message).toContain(
		'production needs RESEND_API_KEY',
	)
})

test('without .env.example, doctor says how to declare settings', async () => {
	const result = await checkDeclaredSettings(
		await mkdtemp(join(tmpdir(), 'kora-settings-')),
		{},
		false,
	)
	expect(result.status).toBe('warn')
	expect(result.fix).toContain('[required]')
})
