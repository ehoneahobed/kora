import { KoraError } from '@korajs/core'

// ============================================================================
// Webhook Types
// ============================================================================

/**
 * Events that can trigger webhooks.
 */
const WEBHOOK_EVENTS = [
	'user.created',
	'user.updated',
	'user.deleted',
	'user.signin',
	'user.signout',
	'user.password_changed',
	'user.email_verified',
	'mfa.enabled',
	'mfa.disabled',
	'session.created',
	'session.revoked',
	'org.created',
	'org.updated',
	'org.deleted',
	'org.member_added',
	'org.member_removed',
	'org.invitation_created',
	'org.invitation_accepted',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/**
 * A webhook endpoint configuration.
 */
export interface WebhookEndpoint {
	/** Unique endpoint ID */
	id: string
	/** Destination URL */
	url: string
	/** Events this endpoint subscribes to */
	events: WebhookEvent[]
	/** Signing secret for HMAC verification */
	secret: string
	/** Whether this endpoint is active */
	active: boolean
	/** When this endpoint was created */
	createdAt: number
	/** Custom metadata */
	metadata?: Record<string, unknown>
}

/**
 * A webhook delivery attempt.
 */
export interface WebhookDelivery {
	/** Unique delivery ID */
	id: string
	/** Endpoint ID */
	endpointId: string
	/** Event that triggered this delivery */
	event: WebhookEvent
	/** Request payload (JSON) */
	payload: string
	/** HTTP response status (null if network error) */
	responseStatus: number | null
	/** Whether the delivery was successful (2xx response) */
	success: boolean
	/** Error message if delivery failed */
	error: string | null
	/** Number of attempts made */
	attempts: number
	/** When the delivery was first attempted */
	createdAt: number
	/** When the delivery was last attempted */
	lastAttemptAt: number
}

/**
 * Payload sent to webhook endpoints.
 */
export interface WebhookPayload {
	/** Unique event ID */
	id: string
	/** Event type */
	event: WebhookEvent
	/** When the event occurred */
	timestamp: number
	/** Event data */
	data: Record<string, unknown>
}

/**
 * Store for webhook endpoints and deliveries.
 */
export interface WebhookStore {
	/** Save a webhook endpoint */
	saveEndpoint(endpoint: WebhookEndpoint): Promise<void>
	/** Get an endpoint by ID */
	getEndpoint(id: string): Promise<WebhookEndpoint | null>
	/** List all endpoints */
	listEndpoints(): Promise<WebhookEndpoint[]>
	/** Delete an endpoint */
	deleteEndpoint(id: string): Promise<void>
	/** Save a delivery record */
	saveDelivery(delivery: WebhookDelivery): Promise<void>
	/** List recent deliveries for an endpoint */
	listDeliveries(endpointId: string, limit?: number): Promise<WebhookDelivery[]>
}

// ============================================================================
// Errors
// ============================================================================

export class WebhookError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'WebhookError'
	}
}

export class WebhookEndpointNotFoundError extends WebhookError {
	constructor(id: string) {
		super(`Webhook endpoint "${id}" not found.`, 'WEBHOOK_ENDPOINT_NOT_FOUND', { id })
	}
}

// ============================================================================
// InMemoryWebhookStore
// ============================================================================

export class InMemoryWebhookStore implements WebhookStore {
	private readonly endpoints = new Map<string, WebhookEndpoint>()
	private readonly deliveries: WebhookDelivery[] = []

	async saveEndpoint(endpoint: WebhookEndpoint): Promise<void> {
		this.endpoints.set(endpoint.id, { ...endpoint })
	}

	async getEndpoint(id: string): Promise<WebhookEndpoint | null> {
		const ep = this.endpoints.get(id)
		return ep ? { ...ep } : null
	}

	async listEndpoints(): Promise<WebhookEndpoint[]> {
		return [...this.endpoints.values()].map((e) => ({ ...e }))
	}

	async deleteEndpoint(id: string): Promise<void> {
		this.endpoints.delete(id)
	}

	async saveDelivery(delivery: WebhookDelivery): Promise<void> {
		const existing = this.deliveries.findIndex((d) => d.id === delivery.id)
		if (existing >= 0) {
			this.deliveries[existing] = { ...delivery }
		} else {
			this.deliveries.push({ ...delivery })
		}
	}

	async listDeliveries(endpointId: string, limit = 50): Promise<WebhookDelivery[]> {
		return this.deliveries
			.filter((d) => d.endpointId === endpointId)
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit)
			.map((d) => ({ ...d }))
	}
}

// ============================================================================
// WebhookManager
// ============================================================================

const MAX_RETRIES = 3
const RETRY_DELAYS_MS = [1000, 5000, 30000] // 1s, 5s, 30s

/**
 * Manages webhook registrations and event delivery.
 *
 * Sends HTTP POST requests to registered endpoints when auth events occur.
 * Includes HMAC-SHA256 signature verification and retry logic.
 *
 * @example
 * ```typescript
 * const webhooks = new WebhookManager({
 *   store: new InMemoryWebhookStore(),
 * })
 *
 * // Register an endpoint
 * const endpoint = await webhooks.register({
 *   url: 'https://myapp.com/webhooks/auth',
 *   events: ['user.created', 'user.signin'],
 * })
 *
 * // Dispatch an event (usually called internally by auth system)
 * await webhooks.dispatch('user.created', { userId: 'user-123', email: 'alice@example.com' })
 * ```
 */
export class WebhookManager {
	private readonly store: WebhookStore
	private readonly fetchFn: typeof globalThis.fetch
	private readonly allowPrivateTargets: boolean
	private readonly resolveHost: ((host: string) => Promise<string[]>) | null

	/**
	 * @param config.store - Endpoint and delivery storage
	 * @param config.fetch - Custom fetch. A custom fetch (for example through an
	 *   egress proxy) owns its own network policy, so Kora skips its delivery-time
	 *   DNS check unless `resolveHost` is also given.
	 * @param config.allowPrivateTargets - Development only: allow http:// and
	 *   loopback/private/link-local targets. Default false.
	 * @param config.resolveHost - Resolve a hostname to addresses at delivery time
	 *   (defaults to node:dns when no custom fetch is given), so a public name that
	 *   points at a private address is refused (SSRF, DNS rebinding).
	 */
	constructor(config: {
		store: WebhookStore
		fetch?: typeof globalThis.fetch
		allowPrivateTargets?: boolean
		resolveHost?: (host: string) => Promise<string[]>
	}) {
		this.store = config.store
		this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis)
		this.allowPrivateTargets = config.allowPrivateTargets === true
		this.resolveHost = config.resolveHost ?? (config.fetch ? null : resolveWithNodeDns)
	}

	/**
	 * Register a new webhook endpoint.
	 */
	async register(params: {
		url: string
		events: WebhookEvent[]
		metadata?: Record<string, unknown>
	}): Promise<WebhookEndpoint> {
		assertSafeWebhookUrl(params.url, this.allowPrivateTargets)
		const endpoint: WebhookEndpoint = {
			id: generateId(),
			url: params.url,
			events: [...params.events],
			secret: generateSecret(),
			active: true,
			createdAt: Date.now(),
			metadata: params.metadata,
		}

		await this.store.saveEndpoint(endpoint)
		return endpoint
	}

	/**
	 * Update a webhook endpoint.
	 */
	async update(
		id: string,
		updates: { url?: string; events?: WebhookEvent[]; active?: boolean },
	): Promise<WebhookEndpoint> {
		const endpoint = await this.store.getEndpoint(id)
		if (!endpoint) {
			throw new WebhookEndpointNotFoundError(id)
		}

		if (updates.url !== undefined) {
			assertSafeWebhookUrl(updates.url, this.allowPrivateTargets)
			endpoint.url = updates.url
		}
		if (updates.events !== undefined) endpoint.events = [...updates.events]
		if (updates.active !== undefined) endpoint.active = updates.active

		await this.store.saveEndpoint(endpoint)
		return endpoint
	}

	/**
	 * Delete a webhook endpoint.
	 */
	async remove(id: string): Promise<void> {
		await this.store.deleteEndpoint(id)
	}

	/**
	 * List all webhook endpoints.
	 */
	async list(): Promise<WebhookEndpoint[]> {
		return this.store.listEndpoints()
	}

	/**
	 * Get a specific endpoint.
	 */
	async get(id: string): Promise<WebhookEndpoint> {
		const endpoint = await this.store.getEndpoint(id)
		if (!endpoint) {
			throw new WebhookEndpointNotFoundError(id)
		}
		return endpoint
	}

	/**
	 * Get recent deliveries for an endpoint.
	 */
	async getDeliveries(endpointId: string, limit?: number): Promise<WebhookDelivery[]> {
		return this.store.listDeliveries(endpointId, limit)
	}

	/**
	 * Dispatch an event to all matching webhook endpoints.
	 * Delivery is best-effort with retries.
	 */
	async dispatch(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
		const endpoints = await this.store.listEndpoints()
		const matching = endpoints.filter((ep) => ep.active && ep.events.includes(event))

		const payload: WebhookPayload = {
			id: generateId(),
			event,
			timestamp: Date.now(),
			data,
		}

		const payloadJson = JSON.stringify(payload)

		await Promise.allSettled(matching.map((ep) => this.deliverToEndpoint(ep, payloadJson, event)))
	}

	// --- Private ---

	private async deliverToEndpoint(
		endpoint: WebhookEndpoint,
		payloadJson: string,
		event: WebhookEvent,
	): Promise<void> {
		const delivery: WebhookDelivery = {
			id: generateId(),
			endpointId: endpoint.id,
			event,
			payload: payloadJson,
			responseStatus: null,
			success: false,
			error: null,
			attempts: 0,
			createdAt: Date.now(),
			lastAttemptAt: Date.now(),
		}

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			delivery.attempts = attempt + 1
			delivery.lastAttemptAt = Date.now()

			try {
				await this.assertDeliverable(endpoint.url)
				// Sign the timestamp together with the body, so a captured delivery
				// cannot be replayed later (AUTH-14).
				const timestamp = Math.floor(Date.now() / 1000)
				const signature = await signPayload(`${timestamp}.${payloadJson}`, endpoint.secret)
				const response = await this.fetchFn(endpoint.url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Webhook-Signature': `t=${timestamp},v1=${signature}`,
						'X-Webhook-Timestamp': String(timestamp),
						'X-Webhook-Event': event,
						'X-Webhook-Delivery': delivery.id,
					},
					body: payloadJson,
					redirect: 'manual',
				})

				delivery.responseStatus = response.status
				delivery.success = response.ok

				if (response.ok) {
					await this.store.saveDelivery(delivery)
					return
				}

				delivery.error = `HTTP ${response.status}`
			} catch (err) {
				delivery.error = err instanceof Error ? err.message : 'Network error'
			}

			// Wait before retrying (skip wait on last attempt)
			if (attempt < MAX_RETRIES - 1) {
				await delay(RETRY_DELAYS_MS[attempt] ?? 1000)
			}
		}

		// All retries exhausted
		await this.store.saveDelivery(delivery)
	}

	private async assertDeliverable(url: string): Promise<void> {
		assertSafeWebhookUrl(url, this.allowPrivateTargets)
		if (this.allowPrivateTargets || !this.resolveHost) return
		const host = new URL(url).hostname
		const addresses = await this.resolveHost(host)
		if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
			throw new WebhookTargetError(url)
		}
	}
}

/** Thrown when a webhook URL points at a non-public target. */
export class WebhookTargetError extends WebhookError {
	constructor(url: string) {
		super('Webhook URLs must be https and resolve to public addresses.', 'WEBHOOK_TARGET_REFUSED', {
			url,
		})
		this.name = 'WebhookTargetError'
	}
}

function assertSafeWebhookUrl(url: string, allowPrivate: boolean): void {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new WebhookTargetError(url)
	}
	if (allowPrivate) {
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
			throw new WebhookTargetError(url)
		return
	}
	if (parsed.protocol !== 'https:') throw new WebhookTargetError(url)
	const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
	if (host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host)) {
		throw new WebhookTargetError(url)
	}
}

/**
 * True for loopback, private (RFC 1918 / ULA), link-local (incl. cloud metadata
 * 169.254.169.254), CGNAT, unspecified and IPv4-mapped private addresses.
 * Non-IP strings return false (hostnames are checked after resolution).
 */
function isPrivateAddress(address: string): boolean {
	let host = address.replace(/^\[|\]$/g, '').toLowerCase()
	// URL() normalizes IPv4-mapped IPv6 to hex groups (::ffff:c0a8:1).
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
	if (mapped) {
		const hi = Number.parseInt(mapped[1] as string, 16)
		const lo = Number.parseInt(mapped[2] as string, 16)
		host = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
	}
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(
		host.startsWith('::ffff:') ? host.slice(7) : host,
	)
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])]
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127) ||
			a >= 224
		)
	}
	if (host.includes(':')) {
		return (
			host === '::' ||
			host === '::1' ||
			host.startsWith('fe8') ||
			host.startsWith('fe9') ||
			host.startsWith('fea') ||
			host.startsWith('feb') ||
			host.startsWith('fc') ||
			host.startsWith('fd') ||
			host.startsWith('ff')
		)
	}
	return false
}

async function resolveWithNodeDns(host: string): Promise<string[]> {
	if (isPrivateAddress(host) || /^[\d.]+$/.test(host) || host.includes(':')) return [host]
	const dns = (await import('node:dns/promises')) as {
		lookup(h: string, o: { all: true }): Promise<Array<{ address: string }>>
	}
	const results = await dns.lookup(host, { all: true })
	return results.map((r) => r.address)
}

// ============================================================================
// Helpers
// ============================================================================

function generateId(): string {
	const bytes = new Uint8Array(16)
	globalThis.crypto.getRandomValues(bytes)
	let hex = ''
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i]?.toString(16).padStart(2, '0')
	}
	return hex
}

function generateSecret(): string {
	const bytes = new Uint8Array(32)
	globalThis.crypto.getRandomValues(bytes)
	let hex = ''
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i]?.toString(16).padStart(2, '0')
	}
	return `whsec_${hex}`
}

/**
 * Sign a payload with HMAC-SHA256 for webhook verification.
 */
async function signPayload(payload: string, secret: string): Promise<string> {
	const encoder = new TextEncoder()
	const key = await globalThis.crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(payload))
	const bytes = new Uint8Array(signature)
	let hex = ''
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i]?.toString(16).padStart(2, '0')
	}
	return hex
}

/** Default accepted age of a webhook delivery: 5 minutes. */
const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * Verify a webhook payload signature (`X-Webhook-Signature: t=<unix>,v1=<hex>`).
 *
 * The HMAC covers `${t}.${payload}`, and a delivery older (or newer) than
 * `toleranceSeconds` is rejected, so a captured delivery cannot be replayed.
 *
 * @param payload - The raw request body
 * @param signature - The `X-Webhook-Signature` header
 * @param secret - The endpoint secret
 * @param options - `toleranceSeconds` (default 300)
 * @returns True when the signature is valid and fresh
 */
export async function verifyWebhookSignature(
	payload: string,
	signature: string,
	secret: string,
	options: { toleranceSeconds?: number } = {},
): Promise<boolean> {
	const parts = new Map<string, string>()
	for (const piece of signature.split(',')) {
		const index = piece.indexOf('=')
		if (index > 0) parts.set(piece.slice(0, index).trim(), piece.slice(index + 1).trim())
	}
	const timestamp = Number(parts.get('t'))
	const provided = parts.get('v1')
	if (!Number.isInteger(timestamp) || !provided) return false
	const tolerance = options.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS
	if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > tolerance) return false
	const expected = await signPayload(`${timestamp}.${payload}`, secret)
	// Timing-safe comparison
	if (expected.length !== provided.length) return false
	let result = 0
	for (let i = 0; i < expected.length; i++) {
		result |= expected.charCodeAt(i) ^ provided.charCodeAt(i)
	}
	return result === 0
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
