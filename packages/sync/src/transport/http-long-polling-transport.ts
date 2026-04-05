import { SyncError } from '@kora/core'
import { NegotiatedMessageSerializer } from '../protocol/serializer'
import type { MessageSerializer } from '../protocol/serializer'
import { WebSocketTransport } from './websocket-transport'
import type { SyncTransport, TransportCloseHandler, TransportErrorHandler, TransportMessageHandler, TransportOptions } from './transport'

const DEFAULT_RETRY_DELAY_MS = 250

export interface HttpLongPollingTransportOptions {
	serializer?: MessageSerializer
	fetchImpl?: typeof fetch
	retryDelayMs?: number
	preferWebSocket?: boolean
	webSocketFactory?: () => SyncTransport
}

/**
 * HTTP long-polling transport with optional WebSocket upgrade.
 */
export class HttpLongPollingTransport implements SyncTransport {
	private readonly serializer: MessageSerializer
	private readonly fetchImpl: typeof fetch
	private readonly retryDelayMs: number
	private readonly preferWebSocket: boolean
	private readonly webSocketFactory: () => SyncTransport

	private messageHandler: TransportMessageHandler | null = null
	private closeHandler: TransportCloseHandler | null = null
	private errorHandler: TransportErrorHandler | null = null

	private connected = false
	private polling = false
	private url: string | null = null
	private authToken: string | undefined
	private pollAbort: AbortController | null = null
	private upgradedTransport: SyncTransport | null = null

	constructor(options?: HttpLongPollingTransportOptions) {
		this.serializer = options?.serializer ?? new NegotiatedMessageSerializer('json')
		this.fetchImpl = options?.fetchImpl ?? fetch
		this.retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
		this.preferWebSocket = options?.preferWebSocket ?? true
		this.webSocketFactory = options?.webSocketFactory ?? (() => new WebSocketTransport({ serializer: this.serializer }))
	}

	async connect(url: string, options?: TransportOptions): Promise<void> {
		if (this.connected) {
			throw new SyncError('HTTP long-poll transport already connected', { url })
		}

		this.url = normalizeHttpUrl(url)
		this.authToken = options?.authToken

		if (this.preferWebSocket) {
			const upgraded = await this.tryUpgradeToWebSocket(url, options)
			if (upgraded) {
				this.upgradedTransport = upgraded
				this.connected = true
				return
			}
		}

		this.connected = true
		this.polling = true
		this.pollAbort = new AbortController()
		void this.runPollLoop()
	}

	async disconnect(): Promise<void> {
		if (this.upgradedTransport) {
			await this.upgradedTransport.disconnect()
			this.upgradedTransport = null
		}

		this.connected = false
		this.polling = false
		this.pollAbort?.abort()
		this.pollAbort = null
		this.url = null
	}

	send(message: import('../protocol/messages').SyncMessage): void {
		if (!this.connected) {
			throw new SyncError('Cannot send message: HTTP long-poll transport is not connected', {
				messageType: message.type,
			})
		}

		if (this.upgradedTransport) {
			this.upgradedTransport.send(message)
			return
		}

		void this.postMessage(message)
	}

	onMessage(handler: TransportMessageHandler): void {
		this.messageHandler = handler
		if (this.upgradedTransport) {
			this.upgradedTransport.onMessage(handler)
		}
	}

	onClose(handler: TransportCloseHandler): void {
		this.closeHandler = handler
		if (this.upgradedTransport) {
			this.upgradedTransport.onClose(handler)
		}
	}

	onError(handler: TransportErrorHandler): void {
		this.errorHandler = handler
		if (this.upgradedTransport) {
			this.upgradedTransport.onError(handler)
		}
	}

	isConnected(): boolean {
		if (this.upgradedTransport) {
			return this.upgradedTransport.isConnected()
		}
		return this.connected
	}

	private async tryUpgradeToWebSocket(url: string, options?: TransportOptions): Promise<SyncTransport | null> {
		const wsTransport = this.webSocketFactory()

		if (this.messageHandler) wsTransport.onMessage(this.messageHandler)
		if (this.closeHandler) wsTransport.onClose(this.closeHandler)
		if (this.errorHandler) wsTransport.onError(this.errorHandler)

		try {
			await wsTransport.connect(normalizeWebSocketUrl(url), options)
			return wsTransport
		} catch {
			return null
		}
	}

	private async postMessage(message: import('../protocol/messages').SyncMessage): Promise<void> {
		if (!this.url) return

		const encoded = this.serializer.encode(message)
		const headers = new Headers()
		headers.set('accept', 'application/json, application/x-protobuf')
		if (this.authToken) {
			headers.set('authorization', `Bearer ${this.authToken}`)
		}

		const isBinary = encoded instanceof Uint8Array
		headers.set('content-type', isBinary ? 'application/x-protobuf' : 'application/json')

		try {
			const requestBody = isBinary ? toArrayBuffer(encoded) : encoded

			const response = await this.fetchImpl(this.url, {
				method: 'POST',
				headers,
				body: requestBody,
			})

			if (!response.ok) {
				throw new SyncError('HTTP transport send failed', {
					status: response.status,
					messageType: message.type,
				})
			}
		} catch (error) {
			this.errorHandler?.(error instanceof Error ? error : new Error(String(error)))
		}
	}

	private async runPollLoop(): Promise<void> {
		while (this.polling && this.connected && this.url) {
			try {
				const response = await this.fetchImpl(this.url, {
					method: 'GET',
					headers: this.makePollHeaders(),
					signal: this.pollAbort?.signal,
				})

				if (response.status === 204) {
					await sleep(this.retryDelayMs)
					continue
				}

				if (!response.ok) {
					throw new SyncError('HTTP long-poll request failed', {
						status: response.status,
					})
				}

				const payload = await readResponsePayload(response)
				if (payload === null) {
					continue
				}

				const message = this.serializer.decode(payload)
				this.messageHandler?.(message)
			} catch (error) {
				if (!this.connected || !this.polling) {
					break
				}

				if (isAbortError(error)) {
					break
				}

				this.errorHandler?.(error instanceof Error ? error : new Error(String(error)))
				await sleep(this.retryDelayMs)
			}
		}

		if (!this.connected) {
			this.closeHandler?.('http long-polling disconnected')
		}
	}

	private makePollHeaders(): Headers {
		const headers = new Headers()
		headers.set('accept', 'application/json, application/x-protobuf')
		if (this.authToken) {
			headers.set('authorization', `Bearer ${this.authToken}`)
		}
		return headers
	}
}

function normalizeHttpUrl(url: string): string {
	if (url.startsWith('http://') || url.startsWith('https://')) {
		return url
	}

	if (url.startsWith('ws://')) {
		return `http://${url.slice('ws://'.length)}`
	}

	if (url.startsWith('wss://')) {
		return `https://${url.slice('wss://'.length)}`
	}

	return url
}

function normalizeWebSocketUrl(url: string): string {
	if (url.startsWith('ws://') || url.startsWith('wss://')) {
		return url
	}

	if (url.startsWith('http://')) {
		return `ws://${url.slice('http://'.length)}`
	}

	if (url.startsWith('https://')) {
		return `wss://${url.slice('https://'.length)}`
	}

	return url
}

async function readResponsePayload(response: Response): Promise<string | Uint8Array | null> {
	const contentType = response.headers.get('content-type') ?? ''
	if (contentType.includes('application/x-protobuf')) {
		const buffer = await response.arrayBuffer()
		if (buffer.byteLength === 0) return null
		return new Uint8Array(buffer)
	}

	const text = await response.text()
	if (text.length === 0) return null
	return text
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAbortError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		(error as { name?: string }).name === 'AbortError'
	)
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	const copied = new Uint8Array(data.byteLength)
	copied.set(data)
	return copied.buffer
}
