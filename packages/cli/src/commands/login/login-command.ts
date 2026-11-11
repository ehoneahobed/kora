import { spawn } from 'node:child_process'
import { hostname } from 'node:os'
import { defineCommand } from 'citty'
import { KoraCloudClient } from '../../cloud/cloud-client'
import {
	credentialsPath,
	deleteCredentials,
	readCredentials,
	resolveApiUrl,
	writeCredentials,
} from '../../cloud/credentials'
import { KoraCloudError, KoraCloudSignInRequiredError } from '../../errors'
import { type Logger, createLogger } from '../../utils/logger'

export interface LoginOptions {
	client?: KoraCloudClient | undefined
	logger?: Logger | undefined
	openBrowser?: ((url: string) => void) | undefined
	sleep?: ((milliseconds: number) => Promise<void>) | undefined
	now?: (() => number) | undefined
	env?: NodeJS.ProcessEnv | undefined
}

/**
 * Signs the CLI in to Kora Cloud. It shows a short code and opens the console, where a signed-in
 * person approves that code; the CLI then receives its own token. Works over SSH too: the link
 * can be opened on any device.
 */
export async function runLogin(options: LoginOptions = {}): Promise<{ email: string }> {
	const env = options.env ?? process.env
	const logger = options.logger ?? createLogger()
	const apiUrl = resolveApiUrl(env)
	const client = options.client ?? new KoraCloudClient(apiUrl, null)
	const sleep =
		options.sleep ??
		((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
	const now = options.now ?? Date.now
	const started = await client.startLogin(`${hostname()} (${process.platform})`)
	logger.info(`Your code: ${started.userCode}`)
	logger.step(`Approve it at ${started.verificationUrl}`)
	logger.step('Check that the code shown there matches this one.')
	;(options.openBrowser ?? openBrowser)(started.verificationUrl)
	const deadline = now() + started.expiresIn * 1000
	while (now() < deadline) {
		await sleep(Math.max(1, started.interval) * 1000)
		const result = await client.pollLogin(started.loginId, started.pollSecret)
		if (result.status === 'approved') {
			const path = await writeCredentials({ apiUrl, token: result.token, email: result.email }, env)
			logger.success(`Signed in as ${result.email}`)
			logger.step(`Saved to ${path}`)
			return { email: result.email }
		}
	}
	throw new KoraCloudError(
		'The code expired before it was approved. Run kora login again.',
		'cli_login_expired',
		null,
	)
}

/** Ends this machine's sign-in on Kora Cloud and removes it here. */
export async function runLogout(
	options: Pick<LoginOptions, 'client' | 'logger' | 'env'> = {},
): Promise<void> {
	const env = options.env ?? process.env
	const logger = options.logger ?? createLogger()
	const credentials = await readCredentials(env)
	if (!credentials) {
		logger.info('Not signed in.')
		return
	}
	if (env.KORA_CLOUD_TOKEN) {
		logger.warn(
			'KORA_CLOUD_TOKEN is set, so there is nothing to sign out here. Unset it, or revoke it in the console under Account settings.',
		)
		return
	}
	try {
		await (options.client ?? new KoraCloudClient(credentials.apiUrl, credentials.token)).signOut()
	} catch (error) {
		// An already-ended sign-in only needs removing here.
		if (!(error instanceof KoraCloudSignInRequiredError)) throw error
	}
	await deleteCredentials(env)
	logger.success(`Signed out${credentials.email ? ` ${credentials.email}` : ''}.`)
}

function openBrowser(url: string): void {
	const [command, args] =
		process.platform === 'darwin'
			? ['open', [url]]
			: process.platform === 'win32'
				? ['cmd', ['/c', 'start', '""', url]]
				: ['xdg-open', [url]]
	try {
		const child = spawn(command, args, { stdio: 'ignore', detached: true })
		// No browser (a server, a container) is fine: the link is printed above.
		child.on('error', () => undefined)
		child.unref()
	} catch {
		// Same: the printed link is enough.
	}
}

export const loginCommand = defineCommand({
	meta: { name: 'login', description: 'Sign in to Kora Cloud' },
	args: {
		'no-browser': {
			type: 'boolean',
			description: 'Only print the link, without opening a browser',
			default: false,
		},
	},
	async run({ args }) {
		const logger = createLogger()
		logger.banner()
		const existing = await readCredentials()
		if (existing?.email)
			logger.step(`Currently signed in as ${existing.email}; signing in again replaces it.`)
		await runLogin({
			logger,
			...(args['no-browser'] === true ? { openBrowser: () => undefined } : {}),
		})
	},
})

export const logoutCommand = defineCommand({
	meta: { name: 'logout', description: 'Sign out of Kora Cloud on this machine' },
	async run() {
		await runLogout()
	},
})

export const whoamiCommand = defineCommand({
	meta: { name: 'whoami', description: 'Show which Kora Cloud account this machine uses' },
	async run() {
		const logger = createLogger()
		const credentials = await readCredentials()
		if (!credentials) {
			logger.info('Not signed in. Run kora login.')
			return
		}
		const organizations = await new KoraCloudClient(
			credentials.apiUrl,
			credentials.token,
		).organizations()
		logger.info(
			credentials.email ? `Signed in as ${credentials.email}` : 'Signed in with KORA_CLOUD_TOKEN',
		)
		for (const organization of organizations)
			logger.step(`${organization.name} (${organization.role})`)
		if (!process.env.KORA_CLOUD_TOKEN) logger.step(`Credentials: ${credentialsPath()}`)
	},
})
