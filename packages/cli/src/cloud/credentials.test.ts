import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { deleteCredentials, readCredentials, writeCredentials } from './credentials'

test('a sign-in is saved readable only by the user, for the API it was made against', async () => {
	const env = { XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), 'kora-config-')) }
	const path = await writeCredentials(
		{ apiUrl: 'https://api.koracloud.app', token: 'kcli_x', email: 'a@example.com' },
		env,
	)
	expect((await stat(path)).mode & 0o777).toBe(0o600)
	expect(await readCredentials(env)).toEqual({
		apiUrl: 'https://api.koracloud.app',
		token: 'kcli_x',
		email: 'a@example.com',
	})
	expect(
		await readCredentials({ ...env, KORA_CLOUD_API_URL: 'https://staging.example' }),
	).toBeNull()
	expect(await readCredentials({ ...env, KORA_CLOUD_TOKEN: 'kcli_ci' })).toEqual({
		apiUrl: 'https://api.koracloud.app',
		token: 'kcli_ci',
		email: null,
	})
	await deleteCredentials(env)
	expect(await readCredentials(env)).toBeNull()
})
