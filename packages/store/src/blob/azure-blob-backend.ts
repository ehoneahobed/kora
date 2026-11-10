import { createHash } from 'node:crypto'
import {
	type ObjectProperties,
	type ObjectStorageBackend,
	ObjectStoreError,
	type RetryOptions,
	sendWithRetry,
} from './object-blob-store'

const API_VERSION = '2023-11-03'
const STORAGE_RESOURCE = 'https://storage.azure.com/'
/** Refresh this long before expiry, so a token never lapses in the middle of a request. */
const TOKEN_EARLY_REFRESH_MS = 5 * 60_000

export interface AzureBlobBackendOptions extends RetryOptions {
	/** `https://<account>.blob.core.windows.net/<container>` */
	readonly containerUrl: string
	readonly getToken: () => Promise<string>
}

interface ManagedIdentityEnvironment {
	readonly IDENTITY_ENDPOINT?: string | undefined
	readonly IDENTITY_HEADER?: string | undefined
}

/**
 * Tokens from the managed identity of the Azure workload this process runs in, so the application
 * holds no storage key. `clientId` picks one identity when several are attached.
 */
export function managedIdentityTokenProvider(
	env: ManagedIdentityEnvironment,
	clientId: string | undefined,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): () => Promise<string> {
	let cached: { readonly token: string; readonly expiresAt: number } | null = null
	let pending: Promise<string> | null = null

	async function acquire(): Promise<string> {
		if (!env.IDENTITY_ENDPOINT || !env.IDENTITY_HEADER) {
			throw new ObjectStoreError(
				'No managed identity is available: IDENTITY_ENDPOINT and IDENTITY_HEADER are not set. This store authenticates as an Azure workload, so give the app a managed identity or configure a different blob store.',
				null,
			)
		}
		const url = new URL(env.IDENTITY_ENDPOINT)
		url.searchParams.set('resource', STORAGE_RESOURCE)
		url.searchParams.set('api-version', '2019-08-01')
		if (clientId) url.searchParams.set('client_id', clientId)
		const response = await fetchImpl(url, { headers: { 'X-IDENTITY-HEADER': env.IDENTITY_HEADER } })
		if (!response.ok) {
			throw new ObjectStoreError(
				`The managed identity endpoint refused a storage token (${response.status}). Check that the identity is attached to this app.`,
				response.status,
			)
		}
		const body = (await response.json()) as { access_token: string; expires_on: string | number }
		cached = { token: body.access_token, expiresAt: Number(body.expires_on) * 1000 }
		return body.access_token
	}

	return async () => {
		if (cached && cached.expiresAt - TOKEN_EARLY_REFRESH_MS > Date.now()) return cached.token
		pending ??= acquire().finally(() => {
			pending = null
		})
		return pending
	}
}

export function createAzureBlobBackend(options: AzureBlobBackendOptions): ObjectStorageBackend {
	const container = options.containerUrl.replace(/\/+$/, '')
	const request = async (
		method: string,
		path: string,
		headers: Readonly<Record<string, string>> = {},
		body?: Uint8Array,
	): Promise<Response> =>
		sendWithRetry(
			`${container}${path}`,
			async () => ({
				method,
				headers: {
					authorization: `Bearer ${await options.getToken()}`,
					'x-ms-version': API_VERSION,
					...headers,
				},
				...(body ? { body: body as unknown as BodyInit } : {}),
			}),
			options,
		)
	const failed = (response: Response, action: string): ObjectStoreError =>
		new ObjectStoreError(
			`Could not ${action} a blob in ${container}: ${response.status} (${response.headers.get('x-ms-error-code') ?? 'unknown'}). A 403 means the app's identity has no access to this container yet.`,
			response.status,
		)

	return {
		location: container,
		async putIfAbsent(key, bytes) {
			const response = await request(
				'PUT',
				`/${key}`,
				{
					'x-ms-blob-type': 'BlockBlob',
					'If-None-Match': '*',
					// The service rejects the upload if these bytes were damaged on the way.
					'Content-MD5': createHash('md5').update(bytes).digest('base64'),
					'Content-Type': 'application/octet-stream',
				},
				bytes,
			)
			await response.body?.cancel()
			if (response.status === 201) return 'created'
			if (response.status === 409 || response.status === 412) return 'exists'
			throw failed(response, 'write')
		},
		async touch(key) {
			const response = await request('PUT', `/${key}?comp=metadata`, {
				'x-ms-meta-refreshedat': String(Date.now()),
			})
			if (response.status !== 200) throw failed(response, 'refresh')
		},
		async head(key): Promise<ObjectProperties | null> {
			const response = await request('HEAD', `/${key}`)
			if (response.status === 404) return null
			if (response.status !== 200) throw failed(response, 'inspect')
			return {
				etag: response.headers.get('etag') ?? '',
				bytes: Number(response.headers.get('content-length') ?? 0),
				writtenAt: Date.parse(response.headers.get('last-modified') ?? ''),
			}
		},
		async get(key) {
			const response = await request('GET', `/${key}`)
			if (response.status === 404) return null
			if (response.status !== 200) throw failed(response, 'read')
			return new Uint8Array(await response.arrayBuffer())
		},
		async delete(key, ifEtag) {
			const response = await request('DELETE', `/${key}`, ifEtag ? { 'If-Match': ifEtag } : {})
			if (response.status === 404 || response.status === 412) return false
			if (response.status !== 202) throw failed(response, 'delete')
			return true
		},
		async list() {
			const entries: { key: string; bytes: number }[] = []
			let marker = ''
			do {
				const response = await request(
					'GET',
					`?restype=container&comp=list${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`,
				)
				if (response.status !== 200) throw failed(response, 'list')
				const xml = await response.text()
				for (const [, blob = ''] of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
					const key = blob.match(/<Name>([^<]*)<\/Name>/)?.[1]
					if (key)
						entries.push({
							key,
							bytes: Number(blob.match(/<Content-Length>(\d+)<\/Content-Length>/)?.[1] ?? 0),
						})
				}
				marker = xml.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1] ?? ''
			} while (marker)
			return entries
		},
	}
}
