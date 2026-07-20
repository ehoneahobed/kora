// Seeds a demo Kora DB with realistic multi-device sync history for Studio demos.
import { defineSchema, t } from '@korajs/core'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'

const dbPath = process.argv[2] ?? '/tmp/kora-studio-demo.db'

const schema = defineSchema({
	version: 1,
	collections: {
		tasks: {
			fields: {
				title: t.string(),
				assignee: t.string().optional(),
				priority: t.enum(['low', 'medium', 'high']).default('medium'),
				done: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
			},
		},
		projects: {
			fields: {
				name: t.string(),
				archived: t.boolean().default(false),
			},
		},
	},
})

const store = new Store({ schema, adapter: new BetterSqlite3Adapter(dbPath) })
await store.open()

const proj = await store.collection('projects').insert({ name: 'Kora 0.7.0 release' })
await store.collection('projects').insert({ name: 'Studio prototype' })

const t1 = await store
	.collection('tasks')
	.insert({
		title: 'Fix concurrent edit data loss',
		assignee: 'obed',
		priority: 'high',
		tags: ['sync', 'correctness'],
	})
await store.collection('tasks').update(t1.id, { done: true })

const t2 = await store
	.collection('tasks')
	.insert({
		title: 'Per-field LWW register',
		assignee: 'claude',
		priority: 'high',
		tags: ['store'],
	})
await store.collection('tasks').update(t2.id, { done: true })
await store.collection('tasks').update(t2.id, { tags: ['store', 'merge', 'shipped'] })

const t3 = await store
	.collection('tasks')
	.insert({ title: 'Old roadmap item', priority: 'low', tags: [] })
await store.collection('tasks').delete(t3.id)

// A remote device's operations, applied through the real sync path, so the
// record shows two different last-writers across its fields.
const remoteNode = '01999999-aaaa-7bbb-8ccc-remotedevice'
await store.applyRemoteOperation({
	id: 'demo-remote-op-1',
	nodeId: remoteNode,
	type: 'update',
	collection: 'tasks',
	recordId: t1.id,
	data: { assignee: 'ada' },
	previousData: { assignee: 'obed' },
	timestamp: { wallTime: Date.now() + 5, logical: 0, nodeId: remoteNode },
	sequenceNumber: 1,
	causalDeps: [],
	schemaVersion: 1,
})

await store.collection('tasks').insert({
	title: 'Write 0.7.0 release notes',
	assignee: 'obed',
	priority: 'medium',
	tags: ['docs'],
})

await store.close()
console.log(`Seeded demo DB at ${dbPath} (project ${proj.id})`)
