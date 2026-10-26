import { defineCommand } from 'citty'
import { InvalidProjectError } from '../../errors'
import { findProjectRoot } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { doctorHasFailures, isDatabaseCheck, runDoctorChecks } from './doctor-checks'

/**
 * Diagnose common Kora project setup issues (schema, worker, sync, versions), and with
 * `--db` preflight a production database before a deploy (read-only).
 */
export const doctorCommand = defineCommand({
	meta: {
		name: 'doctor',
		description:
			'Check Kora project setup (schema, worker, sync server, versions); --db preflights a production database',
	},
	args: {
		url: {
			type: 'string',
			description:
				'Sync server HTTP base URL for status probe (default: from .env or localhost:3001)',
		},
		'skip-network': {
			type: 'boolean',
			description: 'Skip sync server and schema version network checks',
			default: false,
		},
		db: {
			type: 'string',
			description:
				'Server database to preflight, read-only: postgres://... URL, SQLite file path, or env:NAME to read it from an environment variable',
		},
		migrations: {
			type: 'string',
			description: 'Generated migrations directory for --db (default: kora/migrations)',
		},
		production: {
			type: 'boolean',
			description: 'Audit production auth, access rules, and package release coherence',
			default: false,
		},
		strict: {
			type: 'boolean',
			description: 'Exit non-zero on warnings too (CI gates); with --db, on database warnings only',
			default: false,
		},
	},
	async run({ args }) {
		const logger = createLogger()
		const projectRoot = await findProjectRoot()
		if (!projectRoot) {
			throw new InvalidProjectError(process.cwd())
		}

		const syncHttpUrl = typeof args.url === 'string' ? args.url : undefined
		const db = typeof args.db === 'string' ? args.db : undefined
		// A database preflight usually runs in CI, where no sync server listens on the
		// default local port: probe one only when --url names it.
		const skipNetwork = args['skip-network'] === true || (db !== undefined && !syncHttpUrl)
		const strict = args.strict === true

		logger.banner()
		logger.info(`Checking project at ${projectRoot}`)
		logger.blank()

		const results = await runDoctorChecks({
			projectRoot,
			production: args.production === true,
			syncHttpUrl,
			skipNetwork,
			...(db !== undefined ? { db } : {}),
			...(typeof args.migrations === 'string' ? { migrationsDir: args.migrations } : {}),
		})

		for (const check of results) {
			const prefix =
				check.status === 'pass'
					? 'success'
					: check.status === 'warn'
						? 'warn'
						: check.status === 'fail'
							? 'error'
							: 'step'
			logger[prefix](`${check.title}: ${check.message}`)
			if (check.fix && check.status !== 'pass' && check.status !== 'skip') {
				logger.step(`  Fix: ${check.fix}`)
			}
		}

		logger.blank()
		const warnings = results.filter((r) => r.status === 'warn').length
		// With --db, project-layout warnings stay informational. Explicit production
		// security warnings remain part of the gate when --production is also present.
		const strictScope =
			db !== undefined
				? (result: (typeof results)[number]) =>
						isDatabaseCheck(result) ||
						(args.production === true && result.id.startsWith('production-'))
				: () => true
		if (doctorHasFailures(results, strict, strictScope)) {
			logger.error(
				results.some((r) => r.status === 'fail')
					? 'Doctor found blocking issues.'
					: `Doctor finished with warning(s)${db !== undefined ? ' in the database preflight' : ''}, which --strict treats as failures.`,
			)
			process.exitCode = 1
			return
		}

		if (warnings > 0) {
			logger.warn(`Doctor finished with ${warnings} warning(s).`)
		} else {
			logger.success('All checks passed.')
		}
	},
})
