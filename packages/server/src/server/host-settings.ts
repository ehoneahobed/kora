import type { ProductionServerConfig } from './production-server'
import type { TrustProxySetting } from './trust-proxy'

/**
 * Fills what the app left out of its production server config from the settings a host sets
 * (Kora Cloud sets all of them; a self-hoster can set any): `KORA_TRUST_PROXY` and the
 * operational tokens `KORA_ADMIN_TOKEN`, `KORA_METRICS_TOKEN`, `KORA_BACKUP_TOKEN`. A value the
 * app passes always wins.
 */
export function withHostSettings(
	config: ProductionServerConfig,
	env: Record<string, string | undefined> = process.env,
): ProductionServerConfig {
	const trustProxy = config.trustProxy ?? parseTrustProxy(env.KORA_TRUST_PROXY)
	const auth = config.operationalAuth ?? {}
	const pick = (own: string | undefined, name: string): string | undefined =>
		own || env[name]?.trim() || undefined
	const adminToken = pick(auth.adminToken, 'KORA_ADMIN_TOKEN')
	const metricsToken = pick(auth.metricsToken, 'KORA_METRICS_TOKEN')
	const backupToken = pick(auth.backupToken, 'KORA_BACKUP_TOKEN')
	return {
		...config,
		...(trustProxy !== undefined ? { trustProxy } : {}),
		operationalAuth: {
			...auth,
			...(adminToken ? { adminToken } : {}),
			...(metricsToken ? { metricsToken } : {}),
			...(backupToken ? { backupToken } : {}),
		},
	}
}

/**
 * `KORA_TRUST_PROXY`: a hop count (`1` for one load balancer in front) or a comma-separated list
 * of trusted proxy IPs and CIDR ranges. Empty or unreadable trusts none.
 */
export function parseTrustProxy(value: string | undefined): TrustProxySetting | undefined {
	const raw = value?.trim()
	if (!raw) return undefined
	if (/^\d+$/.test(raw)) {
		const hops = Number(raw)
		return hops > 0 ? hops : undefined
	}
	const ranges = raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(entry))
	return ranges.length > 0 ? ranges : undefined
}
