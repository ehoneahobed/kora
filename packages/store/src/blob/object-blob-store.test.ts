import { hashBlob } from '@korajs/core'
import { beforeEach, describe, expect, test } from 'vitest'
import { createAzureBlobBackend, managedIdentityTokenProvider } from './azure-blob-backend'
import { BlobIntegrityError } from './content-addressed-blob-store'
import { FilesystemBlobStore } from './filesystem-blob-store'
import { ObjectBlobStore, ObjectStoreError } from './object-blob-store'
import { openBlobStoreFromEnv } from './open-blob-store'
import { createS3BlobBackend, signS3Request } from './s3-blob-backend'

interface FakeBlob {
	bytes: Uint8Array
	etag: number
	modified: number
}

const CONTAINER = 'https://acct.blob.core.windows.net/box'

/** The parts of the Blob REST API the store uses, with Azure's status codes. */
function fakeAzure() {
	const blobs = new Map<string, FakeBlob>()
	const state = {
		clock: 1_700_000_000_000,
		etag: 1,
		failNext: [] as number[],
		pageSize: 1000,
		requests: [] as string[],
		beforeDelete: null as null | ((name: string) => void),
	}
	const fetchImpl = (async (input: string, init: RequestInit = {}) => {
		const method = String(init.method)
		const url = new URL(input)
		state.requests.push(`${method} ${url.pathname}${url.search}`)
		const planned = state.failNext.shift()
		if (planned) return new Response(null, { status: planned })
		const headers = new Headers(init.headers)
		expect(headers.get('authorization')).toBe('Bearer token')
		const name = url.pathname.replace('/box/', '').replace('/box', '')
		if (url.searchParams.get('comp') === 'list') {
			const names = [...blobs.keys()].sort()
			const start = Number(url.searchParams.get('marker') ?? 0)
			const page = names.slice(start, start + state.pageSize)
			const next = start + state.pageSize < names.length ? String(start + state.pageSize) : ''
			return new Response(
				`<EnumerationResults><Blobs>${page.map((n) => `<Blob><Name>${n}</Name><Properties><Content-Length>${blobs.get(n)?.bytes.byteLength}</Content-Length></Properties></Blob>`).join('')}</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`,
				{ status: 200 },
			)
		}
		const blob = blobs.get(name)
		if (method === 'PUT' && url.searchParams.get('comp') === 'metadata') {
			if (!blob) return new Response(null, { status: 404 })
			blob.modified = state.clock
			blob.etag = ++state.etag
			return new Response(null, { status: 200 })
		}
		if (method === 'PUT') {
			if (blob && headers.get('if-none-match') === '*') return new Response(null, { status: 409 })
			blobs.set(name, {
				bytes: new Uint8Array(init.body as Uint8Array),
				etag: ++state.etag,
				modified: state.clock,
			})
			return new Response(null, { status: 201 })
		}
		if (!blob) return new Response(null, { status: 404 })
		if (method === 'DELETE') {
			state.beforeDelete?.(name)
			const current = blobs.get(name)
			if (headers.get('if-match') && headers.get('if-match') !== `"${current?.etag}"`)
				return new Response(null, { status: 412 })
			blobs.delete(name)
			return new Response(null, { status: 202 })
		}
		const responseHeaders = {
			etag: `"${blob.etag}"`,
			'last-modified': new Date(blob.modified).toUTCString(),
		}
		if (method === 'HEAD')
			return new Response(null, {
				status: 200,
				headers: { ...responseHeaders, 'content-length': String(blob.bytes.byteLength) },
			})
		return new Response(blob.bytes as unknown as BodyInit, {
			status: 200,
			headers: responseHeaders,
		})
	}) as typeof globalThis.fetch
	return { blobs, state, fetchImpl }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('ObjectBlobStore on the Azure backend', () => {
	let azure: ReturnType<typeof fakeAzure>
	let store: ObjectBlobStore

	beforeEach(() => {
		azure = fakeAzure()
		store = new ObjectBlobStore(
			createAzureBlobBackend({
				containerUrl: CONTAINER,
				getToken: async () => 'token',
				fetch: azure.fetchImpl,
				sleep: async () => undefined,
			}),
		)
	})

	test('stores and returns verified bytes under the filesystem layout', async () => {
		const ref = await store.put(bytes('hello'))
		expect(azure.blobs.has(`${ref.hash.slice(0, 2)}/${ref.hash}`)).toBe(true)
		expect(await store.get(ref.hash)).toEqual(bytes('hello'))
		expect(await store.has(ref.hash)).toBe(true)
		expect(store.durable).toBe(true)
	})

	test('an absent blob is null, not an error', async () => {
		expect(await store.get('ab'.repeat(32))).toBeNull()
		expect(await store.has('ab'.repeat(32))).toBe(false)
		expect(await store.delete('ab'.repeat(32))).toBe(false)
	})

	test('corrupted bytes are refused, never returned', async () => {
		const ref = await store.put(bytes('good'))
		const stored = azure.blobs.get(`${ref.hash.slice(0, 2)}/${ref.hash}`)
		if (stored) stored.bytes = bytes('evil')
		await expect(store.get(ref.hash)).rejects.toBeInstanceOf(BlobIntegrityError)
	})

	test('storing the same content again keeps one object and refreshes its write time', async () => {
		const ref = await store.put(bytes('same'))
		azure.state.clock += 60_000
		await store.put(bytes('same'))
		expect(azure.blobs.size).toBe(1)
		expect(await store.lastWrittenAt(ref.hash)).toBe(azure.state.clock)
	})

	test('a hash from a client cannot reach outside the container', async () => {
		for (const hostile of ['../../other/secret', '..', 'ab/../../x', 'A'.repeat(64), '']) {
			expect(await store.get(hostile)).toBeNull()
			expect(await store.has(hostile)).toBe(false)
			expect(await store.delete(hostile)).toBe(false)
			expect(await store.deleteIfWrittenBefore(hostile, Number.MAX_SAFE_INTEGER)).toBe(false)
		}
		expect(azure.state.requests).toEqual([])
	})

	test('transient failures are retried, and a permanent one reports what to check', async () => {
		azure.state.failNext = [503, 429]
		const ref = await store.put(bytes('retried'))
		expect(await store.has(ref.hash)).toBe(true)
		azure.state.failNext = [403]
		await expect(store.get(ref.hash)).rejects.toThrow(/identity has no access/)
		azure.state.failNext = [500, 500, 500, 500, 500]
		await expect(store.get(ref.hash)).rejects.toBeInstanceOf(ObjectStoreError)
	})

	test('list, size, and total bytes follow every page', async () => {
		azure.state.pageSize = 2
		for (const text of ['a', 'bb', 'ccc', 'dddd', 'eeeee']) await store.put(bytes(text))
		expect((await store.list()).length).toBe(5)
		expect(await store.size()).toBe(5)
		expect(await store.totalBytes()).toBe(15)
	})

	test('garbage collection spares a recent write', async () => {
		const ref = await store.put(bytes('recent'))
		expect(await store.deleteIfWrittenBefore(ref.hash, azure.state.clock - 1000)).toBe(false)
		expect(await store.has(ref.hash)).toBe(true)
		expect(await store.deleteIfWrittenBefore(ref.hash, azure.state.clock + 1000)).toBe(true)
		expect(await store.has(ref.hash)).toBe(false)
	})

	test('a re-upload racing garbage collection wins', async () => {
		const ref = await store.put(bytes('raced'))
		azure.state.beforeDelete = (name) => {
			const blob = azure.blobs.get(name)
			if (blob) blob.etag = ++azure.state.etag
		}
		expect(await store.deleteIfWrittenBefore(ref.hash, azure.state.clock + 1000)).toBe(false)
		expect(await store.has(ref.hash)).toBe(true)
	})

	test('capacity refuses new content but always accepts existing content', async () => {
		expect(await store.putWithinCapacity(bytes('12345'), 8)).toBe('stored')
		expect(await store.putWithinCapacity(bytes('6789'), 8)).toBe('full')
		expect(await store.putWithinCapacity(bytes('12345'), 8)).toBe('refreshed')
		expect(await store.totalBytes()).toBe(5)
		await store.delete(await hashBlob(bytes('12345')))
		expect(await store.putWithinCapacity(bytes('6789'), 8)).toBe('stored')
	})

	test('concurrent uploads cannot jointly exceed capacity', async () => {
		const outcomes = await Promise.all(
			['aaaa', 'bbbb', 'cccc'].map((text) => store.putWithinCapacity(bytes(text), 8)),
		)
		expect(outcomes.filter((outcome) => outcome === 'stored').length).toBe(2)
		expect(outcomes.filter((outcome) => outcome === 'full').length).toBe(1)
	})
})

describe('managedIdentityTokenProvider', () => {
	const env = { IDENTITY_ENDPOINT: 'http://identity.local/token', IDENTITY_HEADER: 'header' }

	test('asks for storage as the chosen identity and reuses a valid token', async () => {
		const urls: string[] = []
		const fetchImpl = (async (url: URL, init: RequestInit) => {
			urls.push(String(url))
			expect(new Headers(init.headers).get('x-identity-header')).toBe('header')
			return Response.json({
				access_token: 'token',
				expires_on: String(Math.floor(Date.now() / 1000) + 3600),
			})
		}) as unknown as typeof fetch
		const getToken = managedIdentityTokenProvider(env, 'client-1', fetchImpl)
		expect(await Promise.all([getToken(), getToken()])).toEqual(['token', 'token'])
		expect(await getToken()).toBe('token')
		expect(urls.length).toBe(1)
		expect(urls[0]).toContain('client_id=client-1')
		expect(urls[0]).toContain('resource=https%3A%2F%2Fstorage.azure.com%2F')
	})

	test('explains itself outside an Azure workload', async () => {
		await expect(managedIdentityTokenProvider({}, undefined)()).rejects.toThrow(/managed identity/)
	})
})

describe('openBlobStoreFromEnv', () => {
	test('prefers an object store, falls back to a directory, and allows neither', () => {
		expect(
			openBlobStoreFromEnv({ KORA_BLOB_STORE_URL: CONTAINER, KORA_BLOB_DIR: '/d' }),
		).toBeInstanceOf(ObjectBlobStore)
		expect(
			openBlobStoreFromEnv({
				KORA_BLOB_STORE_URL: 's3://bucket',
				KORA_BLOB_STORE_ACCESS_KEY_ID: 'a',
				KORA_BLOB_STORE_SECRET_ACCESS_KEY: 'b',
			}),
		).toBeInstanceOf(ObjectBlobStore)
		expect(openBlobStoreFromEnv({ KORA_BLOB_DIR: '/d' })).toBeInstanceOf(FilesystemBlobStore)
		expect(openBlobStoreFromEnv({})).toBeNull()
	})

	test('a store it cannot use is refused at startup, not at the first upload', () => {
		expect(() => openBlobStoreFromEnv({ KORA_BLOB_STORE_URL: 'https://example.com/x' })).toThrow(
			/isn't a supported store/,
		)
		expect(() => openBlobStoreFromEnv({ KORA_BLOB_STORE_URL: 's3://bucket' })).toThrow(
			/ACCESS_KEY_ID/,
		)
		expect(() => openBlobStoreFromEnv({ KORA_BLOB_STORE_URL: 'nope' })).toThrow(/not a valid URL/)
	})
})

describe('signS3Request', () => {
	// The GET Object example from the AWS Signature Version 4 documentation.
	test('matches the published AWS vector', () => {
		const headers = signS3Request({
			method: 'GET',
			url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
			headers: { range: 'bytes=0-9' },
			payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
			accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
			secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
			region: 'us-east-1',
			now: new Date('2013-05-24T00:00:00Z'),
		})
		expect(headers.authorization).toBe(
			'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
		)
	})
})

describe('ObjectBlobStore on the S3 backend', () => {
	function fakeS3() {
		const objects = new Map<string, { bytes: Uint8Array; etag: number; modified: number }>()
		const state = { clock: 1_700_000_000_000, etag: 1, copyError: false }
		const fetchImpl = (async (input: string, init: RequestInit = {}) => {
			const url = new URL(input)
			const headers = new Headers(init.headers)
			expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /)
			const key = url.pathname.replace('/bucket/', '').replace('/bucket', '')
			if (url.searchParams.get('list-type')) {
				return new Response(
					`<ListBucketResult>${[...objects].map(([name, object]) => `<Contents><Key>${name}</Key><Size>${object.bytes.byteLength}</Size></Contents>`).join('')}</ListBucketResult>`,
				)
			}
			const object = objects.get(key)
			if (init.method === 'PUT' && headers.get('x-amz-copy-source')) {
				if (state.copyError)
					return new Response('<Error><Code>InternalError</Code></Error>', { status: 200 })
				if (object) {
					object.modified = state.clock
					object.etag = ++state.etag
				}
				return new Response('<CopyObjectResult/>', { status: 200 })
			}
			if (init.method === 'PUT') {
				if (object) return new Response(null, { status: 412 })
				objects.set(key, {
					bytes: new Uint8Array(init.body as Uint8Array),
					etag: ++state.etag,
					modified: state.clock,
				})
				return new Response(null, { status: 200 })
			}
			if (init.method === 'DELETE') {
				if (object && headers.get('if-match') && headers.get('if-match') !== `"${object.etag}"`)
					return new Response(null, { status: 412 })
				objects.delete(key)
				return new Response(null, { status: 204 })
			}
			if (!object) return new Response(null, { status: 404 })
			const responseHeaders = {
				etag: `"${object.etag}"`,
				'last-modified': new Date(object.modified).toUTCString(),
			}
			if (init.method === 'HEAD')
				return new Response(null, {
					status: 200,
					headers: { ...responseHeaders, 'content-length': String(object.bytes.byteLength) },
				})
			return new Response(object.bytes as unknown as BodyInit, {
				status: 200,
				headers: responseHeaders,
			})
		}) as typeof globalThis.fetch
		const store = new ObjectBlobStore(
			createS3BlobBackend({
				bucket: 'bucket',
				accessKeyId: 'a',
				secretAccessKey: 'b',
				endpoint: 'http://s3.local',
				fetch: fetchImpl,
				sleep: async () => undefined,
			}),
		)
		return { objects, state, store }
	}

	test('keeps the same guarantees as any other backend', async () => {
		const { objects, state, store } = fakeS3()
		const ref = await store.put(bytes('hello'))
		expect(objects.has(`${ref.hash.slice(0, 2)}/${ref.hash}`)).toBe(true)
		expect(await store.get(ref.hash)).toEqual(bytes('hello'))
		state.clock += 60_000
		await store.put(bytes('hello'))
		expect(objects.size).toBe(1)
		expect(await store.lastWrittenAt(ref.hash)).toBe(state.clock)
		expect(await store.list()).toEqual([ref.hash])
		expect(await store.deleteIfWrittenBefore(ref.hash, state.clock - 1000)).toBe(false)
		expect(await store.deleteIfWrittenBefore(ref.hash, state.clock + 1000)).toBe(true)
		expect(objects.size).toBe(0)
	})

	test('an error hidden inside a successful copy response is not treated as success', async () => {
		const { state, store } = fakeS3()
		await store.put(bytes('hello'))
		state.copyError = true
		await expect(store.put(bytes('hello'))).rejects.toBeInstanceOf(ObjectStoreError)
	})
})
