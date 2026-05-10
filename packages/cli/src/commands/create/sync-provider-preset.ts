import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TemplateName } from '../../types'
import type { DatabaseOption, DatabaseProviderOption } from './options'

interface SyncProviderPresetOptions {
	targetDir: string
	template: TemplateName
	db: DatabaseOption
	dbProvider: DatabaseProviderOption
}

/**
 * Applies provider-specific sync scaffolding adjustments after template copy.
 *
 * The sync server template is environment-driven: SQLite is used when
 * DATABASE_URL is absent, and PostgreSQL is used when DATABASE_URL is present.
 * Provider presets only add provider-specific guidance.
 */
export async function applySyncProviderPreset(options: SyncProviderPresetOptions): Promise<void> {
	if (!isSyncTemplate(options.template)) {
		return
	}
	if (options.db !== 'postgres') {
		return
	}

	const providerName = getProviderDisplayName(options.dbProvider)
	const providerConnectionString = getProviderConnectionStringExample(options.dbProvider)
	const envPath = join(options.targetDir, '.env.example')
	const readmePath = join(options.targetDir, 'README.md')

	const existingReadme = await readFile(readmePath, 'utf-8')
	const existingEnv = await readFile(envPath, 'utf-8')
	const trimmedReadme = existingReadme.trimEnd()
	const trimmedEnv = existingEnv.trimEnd()
	const envSuffix = [
		'',
		`# PostgreSQL provider preset: ${providerName}`,
		`# Example: ${providerConnectionString}`,
	].join('\n')
	const readmeSuffix = [
		'',
		'## PostgreSQL Provider Preset',
		'',
		`Selected DB provider: ${options.dbProvider}`,
		'',
		'This scaffold keeps one sync server entrypoint. When `DATABASE_URL` is set, `server.ts` uses PostgreSQL. When it is empty, the same server uses SQLite at `KORA_SERVER_DB`.',
		'',
	].join('\n')
	const readmeTemplate = `${trimmedReadme}${readmeSuffix}`

	await writeFile(envPath, `${trimmedEnv}${envSuffix}\n`, 'utf-8')
	await writeFile(readmePath, readmeTemplate, 'utf-8')
}

function isSyncTemplate(template: TemplateName): boolean {
	return (
		template === 'react-sync' || template === 'react-tailwind-sync' || template === 'tauri-react'
	)
}

function getProviderDisplayName(provider: DatabaseProviderOption): string {
	switch (provider) {
		case 'supabase':
			return 'Supabase'
		case 'neon':
			return 'Neon'
		case 'railway':
			return 'Railway'
		case 'vercel-postgres':
			return 'Vercel Postgres'
		case 'custom':
			return 'Custom'
		case 'local':
			return 'Local Postgres'
		case 'none':
			return 'PostgreSQL'
	}
}

function getProviderConnectionStringExample(provider: DatabaseProviderOption): string {
	switch (provider) {
		case 'supabase':
			return 'postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require'
		case 'neon':
			return 'postgresql://<user>:<password>@<branch>.<project>.neon.tech/neondb?sslmode=require'
		case 'railway':
			return 'postgresql://postgres:<password>@<host>.railway.app:<port>/railway?sslmode=require'
		case 'vercel-postgres':
			return 'postgresql://<user>:<password>@<host>.pooler.vercel-storage.com:5432/verceldb?sslmode=require'
		case 'custom':
			return 'postgresql://<user>:<password>@<host>:5432/<database>'
		case 'local':
			return 'postgresql://postgres:postgres@localhost:5432/kora'
		case 'none':
			return 'postgresql://postgres:postgres@localhost:5432/kora'
	}
}
