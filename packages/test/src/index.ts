// @korajs/test — testing harness for Kora.js
// Creates virtual device networks for testing sync convergence and conflicts.

// === Factory ===
export { createTestNetwork, createMixedTestNetwork } from './test-network'
export type {
	TestNetwork,
	TestNetworkOptions,
	MixedTestDeviceConfig,
} from './test-network'

// === Device ===
export { TestDevice } from './test-device'
export type { TestDeviceOptions } from './test-device'

// === Server ===
export { TestServer } from './test-server'
export type { TestServerOptions } from './test-server'

// === Assertions ===
export { checkConvergence, expectConverged, expectConvergedEventually } from './assertions'
export type {
	CollectionDifference,
	ConvergenceResult,
	FieldDifference,
} from './assertions'

// === Re-export ChaosTransport for convenience ===
export { ChaosTransport } from '@korajs/sync'
export type { ChaosConfig } from '@korajs/sync'
