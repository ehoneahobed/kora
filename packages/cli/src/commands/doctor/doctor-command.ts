import { defineCommand } from 'citty'
import { InvalidProjectError } from '../../errors'
import { findProjectRoot } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import { doctorHasFailures, runDoctorChecks } from './doctor-checks'

/**
 * Diagnose common Kora project setup issues (schema, worker, sync, versions).
 */
export const doctorCommand = defineCommand({
	meta: {
		name: 'doctor',
		description: 'Check Kora project setup (schema, worker, sync server, versions)',
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
	},
	async run({ args }) {
		const logger = createLogger()
		const projectRoot = await findProjectRoot()
		if (!projectRoot) {
			throw new InvalidProjectError(process.cwd())
		}

		const syncHttpUrl = typeof args.url === 'string' ? args.url : undefined
		const skipNetwork = args['skip-network'] === true

		logger.banner()
		logger.info(`Checking project at ${projectRoot}`)
		logger.blank()

		const results = await runDoctorChecks({
			projectRoot,
			syncHttpUrl,
			skipNetwork,
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
		if (doctorHasFailures(results)) {
			logger.error('Doctor found blocking issues.')
			process.exitCode = 1
			return
		}

		const warnings = results.filter((r) => r.status === 'warn').length
		if (warnings > 0) {
			logger.warn(`Doctor finished with ${warnings} warning(s).`)
		} else {
			logger.success('All checks passed.')
		}
	},
})
