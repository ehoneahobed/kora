import { KoraError } from '@korajs/core'
import { createAzureBlobBackend, managedIdentityTokenProvider } from './azure-blob-backend'
import type { ContentAddressedBlobStore } from './content-addressed-blob-store'
import { FilesystemBlobStore } from './filesystem-blob-store'
import { ObjectBlobStore } from './object-blob-store'
import { createS3BlobBackend } from './s3-blob-backend'

export type BlobStoreEnvironment = Readonly<Record<string, string | undefined>>

function invalid(message: string, code: string): KoraError {
	return new KoraError(message, code)
}

/**
 * Opens the blob store the host configured, so application code never names a provider.
 *
 * - `KORA_BLOB_STORE_URL=s3://<bucket>`, with `KORA_BLOB_STORE_ACCESS_KEY_ID`,
 *   `KORA_BLOB_STORE_SECRET_ACCESS_KEY`, and optionally `KORA_BLOB_STORE_REGION` and
 *   `KORA_BLOB_STORE_ENDPOINT` for S3-compatible services such as R2 and MinIO.
 * - `KORA_BLOB_STORE_URL=https://<account>.blob.core.windows.net/<container>`, using the workload's
 *   managed identity (`AZURE_CLIENT_ID` picks one).
 * - `KORA_BLOB_DIR=/path` for a directory.
 *
 * Returns null when none is configured. A store it can't use is refused here, at startup, rather
 * than at the first upload.
 *
 * @example
 * ```typescript
 * const blobs = openBlobStoreFromEnv(process.env)
 * createKoraServer({ store, ...(blobs ? toServerBlobCallbacks(blobs) : {}) })
 * ```
 */
export function openBlobStoreFromEnv(
	env: BlobStoreEnvironment,
): (ContentAddressedBlobStore & { readonly location?: string }) | null {
	const raw = env.KORA_BLOB_STORE_URL?.trim()
	if (raw) {
		let url: URL
		try {
			url = new URL(raw)
		} catch {
			throw invalid(
				'KORA_BLOB_STORE_URL is not a valid URL. Use s3://<bucket> or https://<account>.blob.core.windows.net/<container>.',
				'INVALID_BLOB_STORE_URL',
			)
		}
		if (url.protocol === 's3:') {
			const accessKeyId = env.KORA_BLOB_STORE_ACCESS_KEY_ID
			const secretAccessKey = env.KORA_BLOB_STORE_SECRET_ACCESS_KEY
			if (!accessKeyId || !secretAccessKey)
				throw invalid(
					'An s3:// blob store needs KORA_BLOB_STORE_ACCESS_KEY_ID and KORA_BLOB_STORE_SECRET_ACCESS_KEY.',
					'BLOB_STORE_CREDENTIALS_MISSING',
				)
			return new ObjectBlobStore(
				createS3BlobBackend({
					bucket: url.hostname,
					accessKeyId,
					secretAccessKey,
					...(env.KORA_BLOB_STORE_REGION ? { region: env.KORA_BLOB_STORE_REGION } : {}),
					...(env.KORA_BLOB_STORE_ENDPOINT ? { endpoint: env.KORA_BLOB_STORE_ENDPOINT } : {}),
				}),
			)
		}
		if (url.protocol === 'https:' && url.hostname.endsWith('.blob.core.windows.net')) {
			return new ObjectBlobStore(
				createAzureBlobBackend({
					containerUrl: raw,
					getToken: managedIdentityTokenProvider(env, env.AZURE_CLIENT_ID),
				}),
			)
		}
		throw invalid(
			`KORA_BLOB_STORE_URL points at ${url.host}, which isn't a supported store. Use s3://<bucket> or an Azure Blob container URL.`,
			'UNSUPPORTED_BLOB_STORE',
		)
	}
	const dir = env.KORA_BLOB_DIR?.trim()
	return dir ? new FilesystemBlobStore(dir) : null
}
