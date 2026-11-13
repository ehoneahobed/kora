/**
 * Per-collection fold plans on the server.
 *
 * A record's fold state depends only on its own collection's plan (field kinds, merge
 * strategies, resolvers), the schema transforms and the server's authorities. Stamping
 * each state with its collection's plan, and recording each collection's fingerprint,
 * lets a schema change re-fold the records of the collections it re-planned and nothing
 * else, as client stores already do (`foldPlanFingerprints`).
 *
 * The whole-schema stamp ({@link serverFoldPlanFingerprint}) stays meaningful in two
 * ways: it is still recorded under {@link FOLD_PLAN_FINGERPRINT_KEY} (which instance
 * holds the newest plan during a rolling deploy), and a state stamped with the CURRENT
 * whole-schema stamp is current in every collection (it was folded by an instance with
 * exactly this plan, before per-collection stamps existed).
 */
import { foldPlanFingerprints } from '@korajs/core'
import type { OperationTransform, SchemaDefinition } from '@korajs/core'
import { type SQL, sql } from 'drizzle-orm'
import { planStampOf, serverFoldPlanFingerprint } from './record-fold'
import { SERVER_NODE_PREFIX, normalizeLegacyAuthorities } from './server-identity'

/** `kora_server_meta` key holding the JSON map of {@link serverFoldPlanFingerprints}. */
export const FOLD_PLAN_FINGERPRINTS_KEY = 'fold_plan_fingerprints'

/**
 * Each collection's server fold plan fingerprint: its client fingerprint (format version,
 * plan, transforms) plus the server's explicit authorities, which decide authority
 * classes in every collection.
 */
export function serverFoldPlanFingerprints(
	schema: SchemaDefinition,
	explicitAuthorities: readonly string[],
	transforms: readonly OperationTransform[] = [],
): Record<string, string> {
	const explicit = normalizeLegacyAuthorities(explicitAuthorities)
	const authorities = `|auth:${SERVER_NODE_PREFIX}*${explicit.length > 0 ? `,${explicit.join(',')}` : ''}`
	const out: Record<string, string> = {}
	for (const [name, fingerprint] of Object.entries(foldPlanFingerprints(schema, transforms))) {
		out[name] = `${fingerprint}${authorities}`
	}
	return out
}

/** The stamps a server instance folds with: one per collection, and the whole-schema one. */
export interface ServerPlanStamps {
	/** Stamp of the whole-schema fingerprint (still current for states stamped with it). */
	readonly global: string
	/** Collection name -> stamp of its fingerprint. */
	readonly byCollection: Readonly<Record<string, string>>
	/** Collection name -> fingerprint (recorded under {@link FOLD_PLAN_FINGERPRINTS_KEY}). */
	readonly fingerprints: Readonly<Record<string, string>>
	/** The whole-schema fingerprint (recorded under `FOLD_PLAN_FINGERPRINT_KEY`). */
	readonly globalFingerprint: string
}

/** The stamps of an instance with no schema yet ('' everywhere, as before plans were recorded). */
export const EMPTY_PLAN_STAMPS: ServerPlanStamps = {
	global: '',
	byCollection: {},
	fingerprints: {},
	globalFingerprint: '',
}

/** Compute the stamps of a schema, authorities and transforms. */
export function serverPlanStamps(
	schema: SchemaDefinition,
	explicitAuthorities: readonly string[],
	transforms: readonly OperationTransform[] = [],
): ServerPlanStamps {
	const globalFingerprint = serverFoldPlanFingerprint(schema, explicitAuthorities, transforms)
	const fingerprints = serverFoldPlanFingerprints(schema, explicitAuthorities, transforms)
	const byCollection: Record<string, string> = {}
	for (const [name, fingerprint] of Object.entries(fingerprints)) {
		byCollection[name] = planStampOf(fingerprint)
	}
	return { global: planStampOf(globalFingerprint), byCollection, fingerprints, globalFingerprint }
}

/**
 * Whether a stored fold state of `collection` was folded with the current plan: its own
 * collection's stamp, the current whole-schema stamp (written before per-collection
 * stamps), or '' / null (a state from before plans were recorded, folded as current).
 */
export function isActivePlanStamp(
	stamps: ServerPlanStamps,
	collection: string,
	stamp: string | null | undefined,
): boolean {
	return !stamp || stamp === stamps.byCollection[collection] || stamp === stamps.global
}

/** The stamps current in `collection` (its own and the whole-schema one), for SQL filters. */
export function activeStampsOf(stamps: ServerPlanStamps, collection: string): string[] {
	const own = stamps.byCollection[collection]
	return own === undefined ? [stamps.global] : [own, stamps.global]
}

/** Every stamp current in some collection of the schema. */
export function allActiveStamps(stamps: ServerPlanStamps): string[] {
	return [...Object.values(stamps.byCollection), stamps.global]
}

/**
 * SQL: `column` holds a recorded plan that is none of `active` (a state folded with
 * another plan). Written as the gaps between the sorted active stamps, so the plan index
 * serves it as a few range scans instead of a full scan.
 */
export function outdatedPlanCondition(column: SQL, active: readonly string[]): SQL {
	const stamps = [...new Set(active.filter((stamp) => stamp !== ''))].sort()
	if (stamps.length === 0) return sql`${column} > ''`
	const ranges: SQL[] = []
	let lower: string | null = null
	for (const stamp of stamps) {
		ranges.push(
			lower === null
				? sql`(${column} > '' AND ${column} < ${stamp})`
				: sql`(${column} > ${lower} AND ${column} < ${stamp})`,
		)
		lower = stamp
	}
	ranges.push(sql`${column} > ${lower}`)
	return sql`(${sql.join(ranges, sql` OR `)})`
}

/** What changed between the recorded plans and the current ones. */
export interface ReplanDecision {
	/** Collections whose records must be re-folded with the current plan. */
	readonly replanned: string[]
	/**
	 * States were stamped with the whole-schema stamp (before per-collection stamps) and
	 * that plan is the current one: restamp them with their collection's stamp, no re-fold.
	 */
	readonly restampLegacy: boolean
	/** Whether the recorded fingerprints must be (re)written. */
	readonly write: boolean
}

/**
 * Decide which collections a schema change re-planned.
 *
 * - Per-collection fingerprints recorded: the collections whose fingerprint differs
 *   (new collections included; they hold no states yet).
 * - Only the whole-schema fingerprint recorded (a database from before per-collection
 *   plans): unchanged means nothing to re-fold, and the states are restamped; changed
 *   means every collection, since which ones changed is not known.
 * - Nothing recorded: every collection (states from before plans were recorded).
 */
export function decideReplan(
	stamps: ServerPlanStamps,
	recorded: { fingerprints: string | undefined; globalFingerprint: string | undefined },
): ReplanDecision {
	const collections = Object.keys(stamps.fingerprints)
	const recordedMap = parseFingerprints(recorded.fingerprints)
	if (recordedMap !== null) {
		const replanned = collections.filter((name) => recordedMap[name] !== stamps.fingerprints[name])
		const sameSet =
			Object.keys(recordedMap).length === collections.length &&
			collections.every((name) => name in recordedMap)
		return {
			replanned,
			restampLegacy: false,
			write:
				replanned.length > 0 || !sameSet || recorded.globalFingerprint !== stamps.globalFingerprint,
		}
	}
	if (recorded.globalFingerprint === stamps.globalFingerprint) {
		return { replanned: [], restampLegacy: true, write: true }
	}
	return { replanned: collections, restampLegacy: false, write: true }
}

function parseFingerprints(raw: string | undefined): Record<string, string> | null {
	if (raw === undefined) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
		const out: Record<string, string> = {}
		for (const [name, value] of Object.entries(parsed)) {
			if (typeof value === 'string') out[name] = value
		}
		return out
	} catch {
		// Unreadable: treated as absent, which re-folds conservatively.
		return null
	}
}
