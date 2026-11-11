// Node-only entry point for @korajs/store/blob-object.
export { openBlobStoreFromEnv, type BlobStoreEnvironment } from './blob/open-blob-store'
export {
	ObjectBlobStore,
	ObjectStoreError,
	type ObjectProperties,
	type ObjectStorageBackend,
} from './blob/object-blob-store'
export {
	createAzureBlobBackend,
	managedIdentityTokenProvider,
	type AzureBlobBackendOptions,
} from './blob/azure-blob-backend'
export { createS3BlobBackend, type S3BlobBackendOptions } from './blob/s3-blob-backend'
// What a server needs to keep the bytes behind blob fields, from one server-only entry point.
export { toServerBlobCallbacks, type ServerBlobCallbacks } from './blob/server-blob-callbacks'
export {
	collectBlobGarbage,
	DEFAULT_BLOB_GC_GRACE_MS,
	type BlobGcOptions,
	type BlobGcResult,
} from './blob/blob-gc'
export type { ContentAddressedBlobStore } from './blob/content-addressed-blob-store'
