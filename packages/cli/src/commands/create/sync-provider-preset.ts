import { writeFile } from 'node:fs/promises'
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
 * This is a lightweight bridge until template-layer composition lands.
 * Today we only specialize the sync server template when Postgres is selected.
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
	const serverPath = join(options.targetDir, 'server.ts')
	const envPath = join(options.targetDir, '.env.example')

	const serverTemplate = [
		"import { createPostgresServerStore, createProductionServer } from '@korajs/server'",
		'',
		`// PostgreSQL provider preset: ${providerName}`,
		'// Ensure DATABASE_URL is set in your environment.',
		'',
		'async function start(): Promise<void> {',
		"\tconst connectionString = process.env.DATABASE_URL || ''",
		'\tif (connectionString.length === 0) {',
		"\t\tthrow new Error('DATABASE_URL is required for PostgreSQL sync server store.')",
		'\t}',
		'',
		'\tconst store = await createPostgresServerStore({ connectionString })',
		'\tconst server = createProductionServer({',
		'\t\tstore,',
		"\t\tport: Number(process.env.PORT) || 3001,",
		"\t\tstaticDir: './dist',",
		"\t\tsyncPath: '/kora-sync',",
		'\t})',
		'',
		'\tconst url = await server.start()',
		'\tconsole.log(`Kora app running at ${url}`)',
		'}',
		'',
		'void start()',
		'',
	].join('\n')

	const envTemplate = [
		'# Kora Sync Server',
		'# WebSocket URL for the sync server (used by the client)',
		'VITE_SYNC_URL=ws://localhost:3001',
		'',
		'# Sync server port',
		'PORT=3001',
		'',
		`# PostgreSQL connection string (${providerName})`,
		`# Example: ${providerConnectionString}`,
		'DATABASE_URL=',
		'',
	].join('\n')

	await writeFile(serverPath, serverTemplate, 'utf-8')
	await writeFile(envPath, envTemplate, 'utf-8')
}

function isSyncTemplate(template: TemplateName): boolean {
	return template === 'react-sync' || template === 'react-tailwind-sync'
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
