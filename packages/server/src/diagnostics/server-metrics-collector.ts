import type { AuthContext, SessionState } from '../types'

/**
 * Snapshot of server-side sync metrics at a point in time.
 */
export interface ServerMetricsSnapshot {
	connectedClients: number
	connectedNodeIds: string[]
	peakConnections: number
	connectionsTotal: number
	operationsReceived: number
	operationsSent: number
	bytesReceived: number
	bytesSent: number
	clients: ClientMetrics[]
	uptime: number
	totalOperations: number
	errorCount: number
	schemaVersion: number
}

/**
 * Per-client metrics tracked by the server.
 */
export interface ClientMetrics {
	sessionId: string
	nodeId: string | null
	state: SessionState
	connectedAt: number
	operationsReceived: number
	operationsSent: number
	authContext: AuthContext | null
}

/**
 * Collects and aggregates server-side sync metrics.
 *
 * Tracks connected clients, throughput, error counts, and per-session
 * metadata. Designed to be hooked into KoraSyncServer lifecycle events.
 */
/**
 * Estimate the byte size of a batch of operations.
 * Used for bandwidth tracking in sync events.
 * Each operation is approximated by JSON-serializing and measuring length.
 */
export function estimateByteSize(operations: Array<unknown>): number {
	let total = 0
	for (const op of operations) {
		total += JSON.stringify(op).length
	}
	return total
}

export class ServerMetricsCollector {
	private startedAt = Date.now()

	private peakConnections = 0
	private connectionsTotal = 0
	private operationsReceived = 0
	private operationsSent = 0
	private bytesReceived = 0
	private bytesSent = 0
	private errorCount = 0
	private schemaVersion = 1

	private readonly clientMetrics = new Map<string, ClientMetrics>()

	/** Record a new client connection. */
	recordConnection(sessionId: string): void {
		this.connectionsTotal++
		this.clientMetrics.set(sessionId, {
			sessionId,
			nodeId: null,
			state: 'connected',
			connectedAt: Date.now(),
			operationsReceived: 0,
			operationsSent: 0,
			authContext: null,
		})
		this.peakConnections = Math.max(this.peakConnections, this.clientMetrics.size)
	}

	/** Record a client disconnection. */
	recordDisconnection(sessionId: string): void {
		this.clientMetrics.delete(sessionId)
	}

	/** Update the node ID after a handshake completes. */
	recordHandshake(sessionId: string, nodeId: string): void {
		const client = this.clientMetrics.get(sessionId)
		if (client) {
			client.nodeId = nodeId
		}
	}

	/** Update session state. */
	updateSessionState(sessionId: string, state: SessionState): void {
		const client = this.clientMetrics.get(sessionId)
		if (client) {
			client.state = state
		}
	}

	/** Record authentication context for a session. */
	recordAuth(sessionId: string, authContext: AuthContext | null): void {
		const client = this.clientMetrics.get(sessionId)
		if (client) {
			client.authContext = authContext
		}
	}

	/** Record operations received from a client. */
	recordReceived(sessionId: string, count: number, byteSize: number): void {
		this.operationsReceived += count
		this.bytesReceived += byteSize
		const client = this.clientMetrics.get(sessionId)
		if (client) {
			client.operationsReceived += count
		}
	}

	/** Record operations sent to a client. */
	recordSent(sessionId: string, count: number, byteSize: number): void {
		this.operationsSent += count
		this.bytesSent += byteSize
		const client = this.clientMetrics.get(sessionId)
		if (client) {
			client.operationsSent += count
		}
	}

	/** Record an error. */
	recordError(): void {
		this.errorCount++
	}

	/** Set the schema version. */
	setSchemaVersion(version: number): void {
		this.schemaVersion = version
	}

	/** Return a full snapshot of current metrics. */
	getSnapshot(totalOperations: number): ServerMetricsSnapshot {
		return {
			connectedClients: this.clientMetrics.size,
			connectedNodeIds: Array.from(this.clientMetrics.values())
				.filter((c) => c.nodeId !== null)
				.map((c) => c.nodeId as string),
			peakConnections: this.peakConnections,
			connectionsTotal: this.connectionsTotal,
			operationsReceived: this.operationsReceived,
			operationsSent: this.operationsSent,
			bytesReceived: this.bytesReceived,
			bytesSent: this.bytesSent,
			clients: Array.from(this.clientMetrics.values()),
			uptime: Date.now() - this.startedAt,
			totalOperations,
			errorCount: this.errorCount,
			schemaVersion: this.schemaVersion,
		}
	}

	/** Reset all metrics. */
	reset(): void {
		this.startedAt = Date.now()
		this.peakConnections = 0
		this.connectionsTotal = 0
		this.operationsReceived = 0
		this.operationsSent = 0
		this.bytesReceived = 0
		this.bytesSent = 0
		this.errorCount = 0
		this.clientMetrics.clear()
	}
}
