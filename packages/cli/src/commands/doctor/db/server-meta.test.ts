import { defineSchema, foldPlanFingerprint, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
// The server's own definitions, read from its source (the CLI may not depend on it at
// runtime): the doctor's restatements must never drift from them.
import { SERVER_LOG_INTEGRITY_META_KEY as SERVER_INTEGRITY } from '../../../../../server/src/store/log-integrity'
import { FOLD_PLAN_FINGERPRINT_KEY as SERVER_FOLD } from '../../../../../server/src/store/record-fold'
import {
	SCOPE_SNAPSHOT_FINGERPRINT_KEY as SERVER_SNAPSHOT,
	scopeSnapshotFingerprint as serverSnapshotFingerprint,
} from '../../../../../server/src/store/scope-snapshot'
import {
	SERVER_EVER_AUTHORITY_KEY as SERVER_EVER,
	SERVER_LEGACY_AUTHORITY_KEY as SERVER_LEGACY,
	RESERVED_NODE_PREFIX as SERVER_RESERVED,
} from '../../../../../server/src/store/server-identity'
import { RELEASED_NODE_OWNER as SERVER_RELEASED } from '../../../../../server/src/store/server-store'
import { parseDoctorDatabaseUrl, scrubSecrets } from './database'
import { formatDuration, unmatchableWhereReason } from './db-checks'
import {
	FOLD_PLAN_FINGERPRINT_KEY,
	RELEASED_NODE_OWNER,
	RESERVED_NODE_PREFIX,
	SCOPE_SNAPSHOT_FINGERPRINT_KEY,
	SERVER_EVER_AUTHORITY_KEY,
	SERVER_LEGACY_AUTHORITY_KEY,
	SERVER_LOG_INTEGRITY_META_KEY,
	replannedCollections,
	scopeSnapshotFingerprint,
} from './server-meta'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
				body: t.richtext(),
				views: t.number().default(0),
				meta: t.json().optional(),
			},
			resolve: { title: (local: unknown) => local },
		},
	},
}) as unknown as SchemaDefinition

describe('doctor server layout', () => {
	test('the meta keys and fingerprints equal the server store definitions', () => {
		expect(FOLD_PLAN_FINGERPRINT_KEY).toBe(SERVER_FOLD)
		expect(SCOPE_SNAPSHOT_FINGERPRINT_KEY).toBe(SERVER_SNAPSHOT)
		expect(SERVER_LOG_INTEGRITY_META_KEY).toBe(SERVER_INTEGRITY)
		expect(SERVER_LEGACY_AUTHORITY_KEY).toBe(SERVER_LEGACY)
		expect(SERVER_EVER_AUTHORITY_KEY).toBe(SERVER_EVER)
		expect(RESERVED_NODE_PREFIX).toBe(SERVER_RESERVED)
		expect(RELEASED_NODE_OWNER).toBe(SERVER_RELEASED)
		expect(scopeSnapshotFingerprint(schema)).toBe(serverSnapshotFingerprint(schema))
	})

	test('an unchanged plan re-plans nothing, even when resolvers are lost in JSON', () => {
		const stored = `${foldPlanFingerprint(schema)}|auth:kora:server:*`
		const fromJson = JSON.parse(JSON.stringify(schema)) as SchemaDefinition
		expect(replannedCollections(stored, fromJson).collections).toEqual([])
	})

	test('a merge strategy change re-plans its collection', () => {
		const stored = `${foldPlanFingerprint(schema)}|auth:kora:server:*`
		const counter = defineSchema({
			version: 1,
			collections: {
				notes: {
					fields: {
						title: t.string(),
						done: t.boolean().default(false),
						body: t.richtext(),
						views: t.number().default(0).merge('counter'),
						meta: t.json().optional(),
					},
				},
			},
		}) as unknown as SchemaDefinition
		expect(replannedCollections(stored, counter).collections).toEqual(['notes'])
	})
})

describe('doctor --db URL', () => {
	test('a Postgres URL is displayed without its password or query', () => {
		const target = parseDoctorDatabaseUrl(
			'postgres://app:p%40ss@db.example.com:5432/prod?sslmode=require',
			'/srv',
		)
		expect(target.dialect).toBe('postgres')
		expect(target.displayName).toBe('postgres://db.example.com:5432/prod')
		expect(scrubSecrets('auth failed for p@ss and p%40ss', target)).toBe(
			'auth failed for *** and ***',
		)
		expect(scrubSecrets('postgres://u:pw@h/db', { secrets: [] })).toBe('postgres://u:***@h/db')
	})

	test('SQLite paths and URLs resolve against the project', () => {
		expect(parseDoctorDatabaseUrl('.kora/kora-server.db', '/srv/app').location).toBe(
			'/srv/app/.kora/kora-server.db',
		)
		expect(parseDoctorDatabaseUrl('sqlite:///data/k.db', '/srv').location).toBe('/data/k.db')
		expect(parseDoctorDatabaseUrl('file:///data/k.db', '/srv').location).toBe('/data/k.db')
	})

	test('env:NAME reads the URL from the environment', () => {
		expect(
			parseDoctorDatabaseUrl('env:DATABASE_URL', '/srv', { DATABASE_URL: 'postgres://h/db' })
				.dialect,
		).toBe('postgres')
		expect(() => parseDoctorDatabaseUrl('env:NOPE', '/srv', {})).toThrow(/NOPE is not set/)
		expect(() => parseDoctorDatabaseUrl('mysql://h/db', '/srv')).toThrow(/unsupported/)
	})
})

describe('doctor checks helpers', () => {
	test('where values that match are not reported', () => {
		const fields = schema.collections.notes?.fields ?? {}
		expect(unmatchableWhereReason(fields.title, 'title', 'x')).toBeNull()
		expect(unmatchableWhereReason(fields.views, 'views', 3)).toBeNull()
		expect(unmatchableWhereReason(undefined, 'id', 'r1')).toBeNull()
		expect(unmatchableWhereReason(fields.done, 'done', true)).toContain('0/1')
		expect(unmatchableWhereReason(fields.meta, 'meta', 'x')).toContain('serialized')
		expect(unmatchableWhereReason(fields.title, 'title', null)).toContain('NULL')
	})

	test('durations read naturally', () => {
		expect(formatDuration(0.2)).toBe('under a second')
		expect(formatDuration(42)).toBe('about 42 s')
		expect(formatDuration(600)).toBe('about 10 min')
		expect(formatDuration(9_000)).toBe('about 2.5 h')
	})
})
