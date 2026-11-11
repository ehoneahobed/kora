import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { missingRequiredEnv, parseEnvExample } from '@korajs/core'
import type { DoctorCheckResult } from './doctor-checks'

/**
 * Checks the settings the app declares in `.env.example` (see `parseEnvExample`). With
 * `production`, a declared `[required]` setting missing from the environment fails, by name
 * and purpose; otherwise the check says what production will need.
 */
export async function checkDeclaredSettings(
	projectRoot: string,
	env: Readonly<Record<string, string | undefined>>,
	production: boolean,
): Promise<DoctorCheckResult> {
	let text: string
	try {
		text = await readFile(join(projectRoot, '.env.example'), 'utf8')
	} catch {
		return {
			id: 'settings',
			title: 'Settings',
			status: 'warn',
			message: "No .env.example: hosts and teammates can't tell which settings the app needs.",
			fix: 'List every variable the app reads in .env.example. Mark ones production needs with "# [required]", credentials with "[secret]", and local-only ones with "[development]".',
		}
	}
	const declared = parseEnvExample(text)
	const required = declared.filter((entry) => entry.required)
	if (production) {
		const missing = missingRequiredEnv(declared, env)
		if (missing.length > 0) {
			return {
				id: 'settings',
				title: 'Settings',
				status: 'fail',
				message: `Required in production but not set: ${missing.map((entry) => (entry.description ? `${entry.name} (${entry.description})` : entry.name)).join('; ')}.`,
				fix: "Set them in the production environment (on Kora Cloud: the project's Settings in the console).",
			}
		}
	}
	return {
		id: 'settings',
		title: 'Settings',
		status: 'pass',
		message:
			required.length > 0
				? `${declared.length} declared in .env.example; production needs ${required.map((entry) => entry.name).join(', ')}.`
				: `${declared.length} declared in .env.example, none marked [required].`,
	}
}
