import { createHash, createHmac } from 'node:crypto'
import {
	type ObjectProperties,
	type ObjectStorageBackend,
	ObjectStoreError,
	type RetryOptions,
	sendWithRetry,
} from './object-blob-store'

export interface S3BlobBackendOptions extends RetryOptions {
	readonly bucket: string
	readonly accessKeyId: string
	readonly secretAccessKey: string
	readonly region?: string
	/** For S3-compatible services such as R2 and MinIO. Defaults to AWS for the region. */
	readonly endpoint?: string
	readonly now?: () => Date
}

const sha256 = (data: string | Uint8Array): string =>
	createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer =>
	createHmac('sha256', key).update(data).digest()
const encodeSegment = (value: string): string =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	)

/** Signs a request with AWS Signature Version 4. Exported so it can be checked against AWS's published vectors. */
export function signS3Request(input: {
	readonly method: string
	readonly url: URL
	readonly headers: Readonly<Record<string, string>>
	readonly payloadHash: string
	readonly accessKeyId: string
	readonly secretAccessKey: string
	readonly region: string
	readonly now: Date
}): Record<string, string> {
	const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '')
	const day = amzDate.slice(0, 8)
	const headers: Record<string, string> = {
		...input.headers,
		host: input.url.host,
		'x-amz-content-sha256': input.payloadHash,
		'x-amz-date': amzDate,
	}
	const names = Object.keys(headers)
		.map((name) => name.toLowerCase())
		.sort()
	const lower = Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()]),
	)
	const signedHeaders = names.join(';')
	const query = [...input.url.searchParams.entries()]
		.map(([name, value]) => [encodeSegment(name), encodeSegment(value)] as const)
		.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
		.map(([name, value]) => `${name}=${value}`)
		.join('&')
	const canonical = [
		input.method,
		input.url.pathname,
		query,
		...names.map((name) => `${name}:${lower[name]}`),
		'',
		signedHeaders,
		input.payloadHash,
	].join('\n')
	const scope = `${day}/${input.region}/s3/aws4_request`
	const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
	const key = hmac(
		hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), 's3'),
		'aws4_request',
	)
	const signature = createHmac('sha256', key).update(toSign).digest('hex')
	return {
		...headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	}
}

/** S3 and the services that speak its API. Needs conditional writes and deletes, which AWS has offered since 2024. */
export function createS3BlobBackend(options: S3BlobBackendOptions): ObjectStorageBackend {
	const region = options.region ?? 'us-east-1'
	const endpoint = (options.endpoint ?? `https://s3.${region}.amazonaws.com`).replace(/\/+$/, '')
	const location = `${endpoint}/${options.bucket}`
	const request = async (
		method: string,
		path: string,
		headers: Readonly<Record<string, string>> = {},
		body?: Uint8Array,
	): Promise<Response> => {
		const target = `${location}${path}`
		const payloadHash = sha256(body ?? '')
		return sendWithRetry(
			target,
			async () => ({
				method,
				headers: signS3Request({
					method,
					url: new URL(target),
					headers,
					payloadHash,
					accessKeyId: options.accessKeyId,
					secretAccessKey: options.secretAccessKey,
					region,
					now: options.now?.() ?? new Date(),
				}),
				...(body ? { body: body as unknown as BodyInit } : {}),
			}),
			options,
		)
	}
	const failed = (response: Response, action: string): ObjectStoreError =>
		new ObjectStoreError(
			`Could not ${action} an object in ${location}: ${response.status}. A 403 means these credentials have no access to this bucket.`,
			response.status,
		)

	return {
		location,
		async putIfAbsent(key, bytes) {
			const response = await request(
				'PUT',
				`/${key}`,
				{
					'if-none-match': '*',
					'content-md5': createHash('md5').update(bytes).digest('base64'),
					'content-type': 'application/octet-stream',
				},
				bytes,
			)
			await response.body?.cancel()
			if (response.status === 200) return 'created'
			if (response.status === 409 || response.status === 412) return 'exists'
			throw failed(response, 'write')
		},
		async touch(key) {
			const response = await request('PUT', `/${key}`, {
				'x-amz-copy-source': `/${options.bucket}/${key}`,
				'x-amz-metadata-directive': 'REPLACE',
				'x-amz-meta-refreshedat': String(Date.now()),
			})
			// A copy can report 200 and still carry an error in its body.
			const text = await response.text()
			if (response.status !== 200 || text.includes('<Error>')) throw failed(response, 'refresh')
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
			const response = await request('DELETE', `/${key}`, ifEtag ? { 'if-match': ifEtag } : {})
			if (response.status === 412 || response.status === 404) return false
			if (response.status !== 204) throw failed(response, 'delete')
			return true
		},
		async list() {
			const entries: { key: string; bytes: number }[] = []
			let token = ''
			do {
				const response = await request(
					'GET',
					`?list-type=2${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`,
				)
				if (response.status !== 200) throw failed(response, 'list')
				const xml = await response.text()
				for (const [, item = ''] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
					const key = item.match(/<Key>([^<]*)<\/Key>/)?.[1]
					if (key) entries.push({ key, bytes: Number(item.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0) })
				}
				token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? ''
			} while (token)
			return entries
		},
	}
}
