/**
 * Properties of the app object that belong to the framework. A schema collection with
 * one of these names is not exposed as `app.<name>` (that would replace the framework
 * API); it is reachable as `app.collections.<name>` and inside transactions as
 * `tx.<name>`. createApp warns once in development when a schema uses one (DX-9).
 *
 * Kept in sync with the object createApp builds by a unit test.
 */
export const RESERVED_APP_PROPERTIES = [
	'ready',
	'events',
	'on',
	'collections',
	'sync',
	'encryption',
	'sequences',
	'blobs',
	'storage',
	'getStore',
	'getSyncEngine',
	'getQueryStoreCache',
	'storeInfo',
	'close',
	'transaction',
	'mutation',
	'exportBackup',
	'importBackup',
	'replayTo',
	'exportAudit',
] as const

/** A property name reserved by the app object. */
export type ReservedAppProperty = (typeof RESERVED_APP_PROPERTIES)[number]

/**
 * Whether createApp runs in a production build. Bundlers replace
 * `process.env.NODE_ENV`; without one (plain browser ESM) this is development.
 */
export function isProductionBuild(): boolean {
	const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process
	return processLike?.env?.NODE_ENV === 'production'
}

/**
 * Warn (development only) about schema collections whose names collide with framework
 * properties of the app object, naming the collision-free way to reach them.
 *
 * @param collectionNames - The schema's collection names
 * @param reserved - The app object's own property names
 */
export function warnShadowedCollections(
	collectionNames: readonly string[],
	reserved: ReadonlySet<PropertyKey>,
): void {
	if (isProductionBuild()) return
	const shadowed = collectionNames.filter((name) => reserved.has(name))
	if (shadowed.length === 0) return
	const plural = shadowed.length > 1
	const list = shadowed.map((name) => `"${name}"`).join(', ')
	const access = shadowed.map((name) => `app.collections.${name}`).join(', ')
	console.warn(
		`[kora] Collection name${plural ? 's' : ''} ${list} ${plural ? 'are' : 'is'} reserved by the app object, so app.${shadowed[0]} is the framework API, not the collection. Use ${access} (and tx.${shadowed[0]} inside transactions), or rename the collection. Reserved names: ${RESERVED_APP_PROPERTIES.join(', ')}.`,
	)
}
