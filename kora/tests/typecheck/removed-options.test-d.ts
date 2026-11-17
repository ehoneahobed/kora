import type { StoreOptions } from '../../src'

// Options removed in 1.0.0-beta.15. Each was deprecated and ignored for at least one release.

// SharedWorker-hosted SQLite cannot use OPFS and was never durable (ignored since beta.6).
// @ts-expect-error sharedWorkerUrl was removed in beta.15
export const sharedWorker: StoreOptions = { sharedWorkerUrl: '/shared-host.js' }
