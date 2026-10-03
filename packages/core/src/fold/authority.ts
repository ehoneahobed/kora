/**
 * Node-id namespaces Kora reserves for itself.
 *
 * Every id starting with {@link RESERVED_NODE_ID_PREFIX} belongs to Kora: devices
 * never author under one (a client refuses to adopt such an id, and the server
 * refuses it at the handshake). Inside it, {@link SERVER_NODE_ID_PREFIX} names the
 * server's own nodes (`kora:server:<stableId>`): their writes are authoritative for
 * `merge('server-authoritative')` fields on every replica, whatever list of node
 * ids a given handshake advertised. That keeps authority stable across server
 * restarts and instances without any replica having to learn the ids first.
 */
export const RESERVED_NODE_ID_PREFIX = 'kora:'

/** Prefix of every server-authored node id: `kora:server:<stableId>`. */
export const SERVER_NODE_ID_PREFIX = 'kora:server:'

/** True when `nodeId` is in Kora's reserved `kora:` namespace. */
export function isReservedNodeId(nodeId: string): boolean {
	return nodeId.startsWith(RESERVED_NODE_ID_PREFIX)
}

/** True when `nodeId` names a server node (`kora:server:<stableId>`). */
export function isServerNodeId(nodeId: string): boolean {
	return nodeId.startsWith(SERVER_NODE_ID_PREFIX) && nodeId.length > SERVER_NODE_ID_PREFIX.length
}

/**
 * Whether a node's writes are authoritative for `merge('server-authoritative')`
 * fields: a server node by prefix, or one of `explicit` (legacy, randomly generated
 * server node ids a server keeps advertising in its handshake).
 *
 * @param nodeId - The writing node
 * @param explicit - Additional authoritative node ids (`FoldOptions.authoritativeNodeIds`)
 */
export function isAuthoritativeNodeId(nodeId: string, explicit?: ReadonlySet<string>): boolean {
	return isServerNodeId(nodeId) || (explicit?.has(nodeId) ?? false)
}
