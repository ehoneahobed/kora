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

// === Protobuf wire transport (for testing convergence through the real wire format) ===
export { wrapTransportPairWithProtobufWire } from './protobuf-wire-transport'
export type { TransportPair } from './protobuf-wire-transport'

// === Server-clock transport (for testing clock-skew / rebase integration) ===
export { wrapTransportPairWithServerClock } from './server-clock-transport'

// === Re-export ChaosTransport for convenience ===
export { ChaosTransport } from '@korajs/sync'
export type { ChaosConfig } from '@korajs/sync'

// === Auth lifecycle and transfer-cost instrumentation ===
export { createTestAuthBinding } from './test-auth'
export type { TestAuthBinding } from './test-auth'
export { createTransportMetrics } from './transport-metrics'
export type { TestTransferMetrics } from './transport-metrics'
