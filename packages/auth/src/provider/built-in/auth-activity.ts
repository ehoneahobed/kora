/**
 * Counts of what the auth routes did, for operators: sign-ins, sign-ups, second factors, OAuth,
 * token refreshes, emails and server errors, by outcome and failure code. Never an email
 * address, user id or token. Kept in memory per server instance, in hourly buckets, so a
 * restart starts again (`since` says when) and instances count separately.
 */

const HOUR_MS = 3_600_000
const BUCKETS = 24
/** A code longer or stranger than this is counted as `OTHER`, so the table stays bounded. */
const CODE_PATTERN = /^[A-Z0-9_]{1,64}$/
const MAX_CODES = 50

/** One outcome group: how many succeeded, failed, and why the failures failed. */
export interface AuthOutcomeCounts {
	readonly succeeded: number
	readonly failed: number
	/** Failures by their error code, such as `INVALID_CREDENTIALS` or `RATE_LIMITED`. */
	readonly byCode: Readonly<Record<string, number>>
}

export interface AuthActivityCounts {
	readonly signIns: AuthOutcomeCounts
	readonly signUps: AuthOutcomeCounts
	readonly mfa: AuthOutcomeCounts
	readonly oauth: AuthOutcomeCounts
	readonly refreshes: AuthOutcomeCounts
	/** Verification and password-reset emails handed to the app's mailer. */
	readonly emails: AuthOutcomeCounts
	/** Requests the auth routes answered with a 5xx. */
	readonly serverErrors: number
}

export interface AuthActivitySnapshot {
	/** When this instance started counting (ms). Windows reaching further back hold less. */
	readonly since: number
	readonly lastHour: AuthActivityCounts
	readonly last24h: AuthActivityCounts
}

export type AuthActivityGroup = 'signIns' | 'signUps' | 'mfa' | 'oauth' | 'refreshes' | 'emails'

interface Bucket {
	hour: number
	counts: Map<string, number>
}

export class AuthActivity {
	readonly since: number
	private readonly buckets: Bucket[] = []

	constructor(private readonly now: () => number = Date.now) {
		this.since = now()
	}

	succeeded(group: AuthActivityGroup): void {
		this.add(`${group}.succeeded`)
	}

	failed(group: AuthActivityGroup, code: string | null | undefined): void {
		this.add(`${group}.failed`)
		const label = code && CODE_PATTERN.test(code) ? code : 'OTHER'
		this.add(`${group}.code.${label}`)
	}

	serverError(): void {
		this.add('serverErrors')
	}

	snapshot(): AuthActivitySnapshot {
		const hour = Math.floor(this.now() / HOUR_MS)
		return {
			since: this.since,
			lastHour: this.read(hour, hour),
			last24h: this.read(hour - BUCKETS + 1, hour),
		}
	}

	private add(name: string): void {
		let key = name
		const hour = Math.floor(this.now() / HOUR_MS)
		let bucket = this.buckets.at(-1)
		if (!bucket || bucket.hour !== hour) {
			bucket = { hour, counts: new Map() }
			this.buckets.push(bucket)
			while (this.buckets.length > 0 && (this.buckets[0]?.hour ?? hour) <= hour - BUCKETS)
				this.buckets.shift()
		}
		// A new code past the cap folds into OTHER, so a flood of odd codes can't grow memory.
		const isCode = key.includes('.code.')
		if (
			isCode &&
			!bucket.counts.has(key) &&
			[...bucket.counts.keys()].filter((k) => k.includes('.code.')).length >= MAX_CODES
		) {
			key = `${key.slice(0, key.indexOf('.code.'))}.code.OTHER`
		}
		bucket.counts.set(key, (bucket.counts.get(key) ?? 0) + 1)
	}

	private read(fromHour: number, toHour: number): AuthActivityCounts {
		const totals = new Map<string, number>()
		for (const bucket of this.buckets) {
			if (bucket.hour < fromHour || bucket.hour > toHour) continue
			for (const [key, value] of bucket.counts) totals.set(key, (totals.get(key) ?? 0) + value)
		}
		const group = (name: AuthActivityGroup): AuthOutcomeCounts => {
			const byCode: Record<string, number> = {}
			const prefix = `${name}.code.`
			for (const [key, value] of totals)
				if (key.startsWith(prefix)) byCode[key.slice(prefix.length)] = value
			return {
				succeeded: totals.get(`${name}.succeeded`) ?? 0,
				failed: totals.get(`${name}.failed`) ?? 0,
				byCode,
			}
		}
		return {
			signIns: group('signIns'),
			signUps: group('signUps'),
			mfa: group('mfa'),
			oauth: group('oauth'),
			refreshes: group('refreshes'),
			emails: group('emails'),
			serverErrors: totals.get('serverErrors') ?? 0,
		}
	}
}

/** Wraps an app's mailer so every send is counted, sent or failed. The failure still throws. */
export function countedSend<M>(
	send: (message: M) => Promise<void> | void,
	activity: AuthActivity,
): (message: M) => Promise<void> {
	return async (message) => {
		try {
			await send(message)
			activity.succeeded('emails')
		} catch (error) {
			activity.failed('emails', 'SEND_FAILED')
			throw error
		}
	}
}
