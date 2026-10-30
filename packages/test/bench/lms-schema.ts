/**
 * Schemas of the LMS-shaped benchmark fixture (lms-first-sync-fixture.ts), in a module of their
 * own so browser apps (the parity benchmark, bench/parity) can import them without pulling the
 * fixture generator and its hashing into their bundles.
 */
import { type SchemaDefinition, defineSchema, t } from '@korajs/core'

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

/** The query a home screen runs first (the "first usable data" probe). */
export const HOME_COLLECTION: LmsCollection = 'courses'

/**
 * The parent of each child collection in the `relations` fixture: modules and lessons belong to a
 * course, questions and lesson progress to a lesson, through a `parentId` field.
 */
export const LMS_RELATION_PARENTS: Readonly<Partial<Record<LmsCollection, LmsCollection>>> = {
	modules: 'courses',
	lessons: 'courses',
	questions: 'lessons',
	lesson_progress: 'lessons',
}

function lmsSchema(relations: boolean): SchemaDefinition {
	return defineSchema({
		version: 1,
		collections: Object.fromEntries(
			LMS_COLLECTIONS.map((collection) => {
				const child = relations && LMS_RELATION_PARENTS[collection] !== undefined
				return [
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
							...(child ? { parentId: t.string().optional() } : {}),
						},
						indexes: child ? ['schoolId', 'parentId'] : ['schoolId'],
						// The school is the delivery partition (design doc, C2 "Partition key"): the
						// server's `{ schoolId }` grants then read the visibility index instead of
						// taking the partition-miss fallback, so the benchmark measures C2's fast path.
						scope: ['schoolId'],
					},
				]
			}),
		),
	}) as SchemaDefinition
}

/** The first-sync benchmark's schema: 30 collections of the same seven fields. */
export const lmsFirstSyncSchema: SchemaDefinition = lmsSchema(false)

/**
 * The same schema with an optional, indexed `parentId` on the child collections of
 * {@link LMS_RELATION_PARENTS}: the schema of `generateLmsFixture({ relations: true })` and of
 * the parity benchmark's apps.
 */
export const lmsRelationsSchema: SchemaDefinition = lmsSchema(true)
