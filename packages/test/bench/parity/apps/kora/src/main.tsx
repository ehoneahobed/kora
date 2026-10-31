/**
 * The parity benchmark's Kora app (design doc, section 2.1): the shared LMS screens with
 * `useQuery` and `useMutation`, `createApp` with default options plus the sync URL, the
 * `koraServiceWorker()` plugin (vite.config.ts) and `<KoraProvider>`, started the way the
 * `react-tailwind-sync` template starts since S4a: `app.sync?.connect()` at once (the socket opens
 * while the store does) and a provider that renders the shell before the database opens.
 *
 * Two additions an app with this auth would write anyway: `sync.auth` returns the bearer token
 * the app keeps in `localStorage` (the baseline sends the same token), and `offline.auth` says
 * that sign-in survives a reload (the token is in `localStorage`), without which a bare token
 * function keeps the offline status `not-ready` forever (`auth-unknown`).
 *
 * Everything under "Observation" only records timings for the harness; it changes no behavior.
 */
import { KoraProvider, useMutation, useQuery } from '@korajs/react'
import { createApp } from 'korajs'
import { type ReactNode, StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type CollectionDigest, digestRows } from '../../../../browser/digest'
import { lmsRelationsSchema } from '../../../../lms-schema'
import { TOKEN_STORAGE_KEY } from '../../shared/parity-types'
import {
	AppShell,
	CourseScreen,
	HomeScreen,
	LessonScreen,
	type Route,
	type Row,
	progressFields,
	toRow,
} from '../../shared/screens'
import koraWorkerUrl from './kora-worker.ts?worker&url'

const token = localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
const school = window.__parityConfig?.school ?? 'school-0'
const syncUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/kora-sync`

export const app = createApp({
	schema: lmsRelationsSchema,
	sync: {
		url: syncUrl,
		auth: async () => ({ token }),
		// Diagnostic variant only (KORA_PARITY_DIAG=subsets-disabled); absent in every matrix run.
		...(window.__parityConfig?.subsets === 'disabled'
			? { querySubsets: { mode: 'disabled' as const } }
			: {}),
	},
	store: {
		workerUrl: koraWorkerUrl,
	},
	offline: {
		auth: async () => ({ restorable: true, until: null }),
	},
})

void app.sync?.connect()

function collection(name: string): NonNullable<(typeof app.collections)[string]> {
	const accessor = app.collections[name]
	if (accessor === undefined) throw new Error(`no collection ${name}`)
	return accessor
}

function rowsOf(records: readonly unknown[]): Row[] {
	return records.map((record) => toRow(record as { id: unknown; title?: unknown }))
}

function Home({ onOpen }: { onOpen: (row: Row) => void }): ReactNode {
	const courses = useQuery(
		collection('courses').where({ schoolId: school }).orderBy('title').limit(50),
	)
	return <HomeScreen courses={rowsOf(courses)} onOpen={onOpen} />
}

function Course({
	courseId,
	title,
	onOpen,
}: {
	courseId: string
	title: string
	onOpen: (row: Row) => void
}): ReactNode {
	const lessons = useQuery(collection('lessons').where({ parentId: courseId }).orderBy('position'))
	return <CourseScreen title={title} lessons={rowsOf(lessons)} onOpen={onOpen} />
}

function Lesson({ lessonId }: { lessonId: string }): ReactNode {
	const lesson = useQuery(collection('lessons').where({ id: lessonId }))
	const questions = useQuery(
		collection('questions').where({ parentId: lessonId }).orderBy('position'),
	)
	const progress = useQuery(
		collection('lesson_progress').where({ parentId: lessonId, ownerId: token }).orderBy('position'),
	)
	const insert = useMutation((fields: Record<string, string | number>) =>
		collection('lesson_progress').insert(fields),
	)
	const first = lesson[0]
	return (
		<LessonScreen
			lesson={first === undefined ? null : toRow(first as { id: unknown; title?: unknown })}
			questions={rowsOf(questions)}
			progress={rowsOf(progress)}
			onMarkDone={() => insert.mutate(progressFields(school, token, lessonId))}
		/>
	)
}

function App(): ReactNode {
	const [route, setRoute] = useState<Route>({ name: 'home' })
	return (
		<AppShell route={route} onHome={() => setRoute({ name: 'home' })}>
			{route.name === 'home' ? (
				<Home onOpen={(row) => setRoute({ name: 'course', courseId: row.id, title: row.title })} />
			) : route.name === 'course' ? (
				<Course
					key={route.courseId}
					courseId={route.courseId}
					title={route.title}
					onOpen={(row) => setRoute({ name: 'lesson', lessonId: row.id, title: row.title })}
				/>
			) : (
				<Lesson key={route.lessonId} lessonId={route.lessonId} />
			)}
		</AppShell>
	)
}

// ── Observation ──────────────────────────────────────────────────────────────────────────

const mark = (name: string): void => window.__parity?.mark(name)
mark('kora:entry')
app.ready.then(
	() => {
		mark('kora:ready')
		const info = app.storeInfo()
		mark(`kora:storage:${info.persistence}:durable=${info.durable}`)
	},
	(error: unknown) => {
		mark('kora:ready-failed')
		console.error('[kora-app] app.ready failed', error)
	},
)
let firstBatch = true
app.on('sync:received', () => {
	if (firstBatch) mark('kora:first-batch')
	firstBatch = false
})
app.on('sync:connected', () => mark('kora:sync-connected'))
let lastOffline = ''
app.offline.subscribe((status) => {
	const key = `${status.state}|data=${status.data.state}|shell=${status.shell.state}|${status.reasons.join(',')}`
	if (key === lastOffline) return
	lastOffline = key
	mark(`offline:${key}`)
	if (status.state === 'ready') mark('kora:offline-ready')
})

window.__parityKora = {
	offlineState: () => app.offline.status().state,
	offlineReasons: () => [...app.offline.status().reasons],
	pendingOperations: () => app.sync?.getStatus().pendingOperations ?? null,
	syncStatus: () => app.sync?.getStatus().status ?? null,
	async digest(collections) {
		const digests: Record<string, CollectionDigest> = {}
		for (const name of collections) {
			const rows = (await collection(name).where({}).exec()) as Array<Record<string, unknown>>
			digests[name] = digestRows(rows)
		}
		return digests
	},
}

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Root element not found')
createRoot(rootElement).render(
	<StrictMode>
		<KoraProvider app={app}>
			<App />
		</KoraProvider>
	</StrictMode>,
)
