import { expect, test } from 'vitest'
import { foldOptionValues } from './argv'

test('deploy options with a separate value are joined, so the value is never taken for a subcommand', () => {
	expect(
		foldOptionValues(['deploy', '--platform', 'kora-cloud', '--prod', '--app', 'my-app']),
	).toEqual(['deploy', '--platform=kora-cloud', '--prod', '--app=my-app'])
	expect(foldOptionValues(['deploy', 'status'])).toEqual(['deploy', 'status'])
	expect(foldOptionValues(['deploy', '--platform=fly', 'logs'])).toEqual([
		'deploy',
		'--platform=fly',
		'logs',
	])
	expect(foldOptionValues(['create', 'my-app', '--template', 'react-sync'])).toEqual([
		'create',
		'my-app',
		'--template',
		'react-sync',
	])
})
