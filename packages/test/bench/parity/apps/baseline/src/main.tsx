/**
 * The parity benchmark's baseline: "a regular web app" (design doc, section 2.1). The shared LMS
 * screens over a plain REST/JSON API served by the same server process and database as the Kora
 * app. A well-built SPA: fetch on route enter, an in-memory per-session cache keyed by URL (a
 * screen opened before renders at once and revalidates), no service worker, no offline support,
 * non-optimistic writes (`POST`, then the row appears from the response).
 */
import { type ReactNode, StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TOKEN_STORAGE_KEY } from '../../shared/parity-types'
import {
	AppShell,
	CourseScreen,
	HomeScreen,
	LessonScreen,
	type Route,
	type Row,
	toRow,
} from '../../shared/screens'

interface ApiRecord {
	id: string
	title?: unknown
}

interface LessonPayload {
	lesson: ApiRecord | null
	questions: ApiRecord[]
	progress: ApiRecord[]
}

const token = localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
const cache = new Map<string, unknown>()

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
		},
	})
	if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url}: HTTP ${response.status}`)
	return (await response.json()) as T
}

/** Fetch on enter; a cached answer renders at once and is revalidated (stale-while-revalidate). */
function useResource<T>(url: string): [T | null, (next: T) => void] {
	const [data, setData] = useState<T | null>(() => (cache.has(url) ? (cache.get(url) as T) : null))
	useEffect(() => {
		let live = true
		api<T>(url).then(
			(fresh) => {
				cache.set(url, fresh)
				if (live) setData(fresh)
			},
			(error: unknown) => console.error('[baseline]', error),
		)
		return () => {
			live = false
		}
	}, [url])
	return [
		data,
		(next) => {
			cache.set(url, next)
			setData(next)
		},
	]
}

function Home({ onOpen }: { onOpen: (row: Row) => void }): ReactNode {
	const [courses] = useResource<ApiRecord[]>('/api/courses')
	return <HomeScreen courses={(courses ?? []).map(toRow)} onOpen={onOpen} />
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
	const [lessons] = useResource<ApiRecord[]>(`/api/courses/${encodeURIComponent(courseId)}/lessons`)
	return <CourseScreen title={title} lessons={(lessons ?? []).map(toRow)} onOpen={onOpen} />
}

function Lesson({ lessonId }: { lessonId: string }): ReactNode {
	const [payload, setPayload] = useResource<LessonPayload>(
		`/api/lessons/${encodeURIComponent(lessonId)}`,
	)
	const markDone = (): void => {
		api<ApiRecord>('/api/progress', { method: 'POST', body: JSON.stringify({ lessonId }) }).then(
			(created) => {
				const current = payload ?? { lesson: null, questions: [], progress: [] }
				setPayload({ ...current, progress: [...current.progress, created] })
			},
			(error: unknown) => console.error('[baseline]', error),
		)
	}
	return (
		<LessonScreen
			lesson={payload?.lesson ? toRow(payload.lesson) : null}
			questions={(payload?.questions ?? []).map(toRow)}
			progress={(payload?.progress ?? []).map(toRow)}
			onMarkDone={markDone}
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

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Root element not found')
createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
