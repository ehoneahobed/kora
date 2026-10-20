/**
 * LMS-shaped fixture for the first-sync benchmark (docs/design/fast-first-sync.md).
 *
 * Shape: 30 collections, every record carries `schoolId` (the tenant) and the device
 * under test is a member of exactly one school. The log is `visibleOps` operations of
 * that school interleaved with `visibleOps * (tenants - 1)` operations of other schools,
 * so a fresh device's in-scope share of the global log is `1 / tenants`.
 *
 * Distribution (per school): a few large "activity" collections dominate the log
 * (progress, attempts, answers, attendance, audit), the "home screen" collections
 * (courses, classes, lessons) are small; 60% inserts, 35% partial updates that do NOT
 * restate `schoolId`, 5% deletes; `moveRate` of updates move a record to another school
 * (scope exit and scope entry). Deterministic for a seed and epoch: the same options give
 * the same operations, ids included.
 */
import { type Operation, type SchemaDefinition, defineSchema, t } from '@korajs/core'
import { computeOperationId } from '@korajs/core/internal'

export const LMS_COLLECTIONS = [
	'users',
	'schools',
	'terms',
	'classes',
	'courses',
	'modules',
	'lessons',
	'lesson_progress',
	'quizzes',
	'questions',
	'answers',
	'attempts',
	'assignments',
	'submissions',
	'grades',
	'enrollments',
	'attendance',
	'announcements',
	'comments',
	'messages',
	'notifications',
	'files',
	'rubrics',
	'badges',
	'certificates',
	'calendars',
	'events',
	'groups',
	'parents',
	'audit_logs',
] as const

export type LmsCollection = (typeof LMS_COLLECTIONS)[number]

/** Relative weight of each collection in the log (unlisted collections weigh 1). */
const WEIGHTS: Partial<Record<LmsCollection, number>> = {
	lesson_progress: 12,
	answers: 12,
	attempts: 8,
	attendance: 8,
	audit_logs: 10,
	notifications: 4,
	messages: 3,
	comments: 2,
}

/** The query a home screen runs first (the "first usable data" probe). */
export const HOME_COLLECTION: LmsCollection = 'courses'

export const lmsFirstSyncSchema: SchemaDefinition = defineSchema({
	version: 1,
	collections: Object.fromEntries(
		LMS_COLLECTIONS.map((collection) => [
			collection,
			{
				fields: {
					schoolId: t.string(),
					ownerId: t.string(),
					title: t.string(),
					body: t.string(),
					status: t.string(),
					score: t.number(),
					position: t.number(),
				},
				indexes: ['schoolId'],
			},
		]),
	),
}) as SchemaDefinition

export interface LmsFixtureOptions {
	/** Operations of the device's own school. Default 20,000. */
	visibleOps?: number
	/** Number of schools sharing the log (1 = the device sees everything). Default 5. */
	tenants?: number
	/** Share of updates that move a record to another school. Default 0.01. */
	moveRate?: number
	/** Number of writer devices per school. Default 40. */
	writersPerSchool?: number
	/** PRNG seed. Default 42. */
	seed?: number
	/**
	 * Wall time (ms) of the first operation. Default {@link LMS_FIXTURE_EPOCH}, so the
	 * same options always produce the same operations (ids included).
	 */
	epoch?: number
}

/**
 * Default wall time of the first fixture operation: a fixed instant in the past (never
 * "from the future" for the server's clock check), so the fixture is the same on every
 * run and its operation ids are stable.
 */
export const LMS_FIXTURE_EPOCH = Date.UTC(2026, 0, 1)

export interface LmsFixture {
	operations: Operation[]
	/** The school the device under test belongs to. */
	school: string
	/** Operations whose record belonged to `school` when written (the visible share). */
	visibleOps: number
	/** Live records of `school` per collection at the end of the log. */
	liveInScope: Record<string, number>
	/** Live records of `school` in the home collection at the end of the log. */
	homeRows: number
}

function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0
		return s / 2 ** 32
	}
}

/**
 * Generate the fixture. Operation ids are real version-2 content hashes, so the server
 * and the device verify them like any upload.
 */
export async function generateLmsFixture(options: LmsFixtureOptions = {}): Promise<LmsFixture> {
	const visibleOps = options.visibleOps ?? 20_000
	const tenants = Math.max(1, options.tenants ?? 5)
	const moveRate = options.moveRate ?? 0.01
	const writersPerSchool = options.writersPerSchool ?? 40
	const r = rng(options.seed ?? 42)
	const school = 'school-0'
	const total = visibleOps * tenants
	const weights = LMS_COLLECTIONS.map((c) => WEIGHTS[c] ?? 1)
	const weightSum = weights.reduce((a, b) => a + b, 0)
	const pick = (): LmsCollection => {
		let x = r() * weightSum
		for (let i = 0; i < LMS_COLLECTIONS.length; i++) {
			x -= weights[i] as number
			if (x <= 0) return LMS_COLLECTIONS[i] as LmsCollection
		}
		return LMS_COLLECTIONS[0]
	}
	// live[school][collection] = record ids
	const live = new Map<string, Map<string, string[]>>()
	const pool = (s: string, c: string): string[] => {
		let bySchool = live.get(s)
		if (!bySchool) {
			bySchool = new Map()
			live.set(s, bySchool)
		}
		let ids = bySchool.get(c)
		if (!ids) {
			ids = []
			bySchool.set(c, ids)
		}
		return ids
	}
	const nodeSeq = new Map<string, number>()
	const operations: Operation[] = []
	let wall = options.epoch ?? LMS_FIXTURE_EPOCH
	let recordCounter = 0
	let visibleCount = 0
	for (let i = 0; i < total; i++) {
		// Round-robin by tenant keeps every school's share exact and interleaved.
		const schoolIdx = i % tenants
		const writingSchool = `school-${schoolIdx}`
		const collection = pick()
		const node = `dev-${schoolIdx}-${Math.floor(r() * writersPerSchool)}`
		const sequenceNumber = (nodeSeq.get(node) ?? 0) + 1
		nodeSeq.set(node, sequenceNumber)
		wall += 1 + Math.floor(r() * 3)
		const ids = pool(writingSchool, collection)
		const roll = r()
		let type: Operation['type']
		let recordId: string
		let data: Record<string, unknown> | null
		let previousData: Record<string, unknown> | null = null
		if (ids.length === 0 || roll < 0.6) {
			type = 'insert'
			recordCounter += 1
			recordId = `${collection}-${recordCounter}`
			ids.push(recordId)
			data = {
				schoolId: writingSchool,
				ownerId: `user-${schoolIdx}-${Math.floor(r() * 500)}`,
				title: `Title ${recordCounter}`,
				body: 'lorem ipsum '.repeat(4 + Math.floor(r() * 20)),
				status: 'active',
				score: Math.floor(r() * 100),
				position: recordCounter,
			}
		} else if (roll < 0.95) {
			type = 'update'
			const at = Math.floor(r() * ids.length)
			recordId = ids[at] as string
			if (tenants > 1 && r() < moveRate) {
				const to = `school-${(schoolIdx + 1 + Math.floor(r() * (tenants - 1))) % tenants}`
				previousData = { schoolId: writingSchool }
				data = { schoolId: to }
				ids.splice(at, 1)
				pool(to, collection).push(recordId)
			} else {
				previousData = { score: 0, status: 'active' }
				data = { score: Math.floor(r() * 100), status: r() < 0.5 ? 'active' : 'done' }
			}
		} else {
			type = 'delete'
			const at = Math.floor(r() * ids.length)
			recordId = ids[at] as string
			ids.splice(at, 1)
			data = null
		}
		if (writingSchool === school) visibleCount += 1
		const body = {
			nodeId: node,
			type,
			collection,
			recordId,
			data,
			previousData,
			timestamp: { wallTime: wall, logical: 0, nodeId: node },
			sequenceNumber,
			causalDeps: [] as string[],
			schemaVersion: 1,
		}
		const id = await computeOperationId(body, 2)
		operations.push({ id, ...body, hashVersion: 2 })
	}
	const liveInScope: Record<string, number> = {}
	for (const [c, ids] of live.get(school) ?? new Map<string, string[]>())
		liveInScope[c] = ids.length
	return {
		operations,
		school,
		visibleOps: visibleCount,
		liveInScope,
		homeRows: liveInScope[HOME_COLLECTION] ?? 0,
	}
}
