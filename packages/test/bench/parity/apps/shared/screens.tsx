/**
 * The LMS screens of the parity benchmark, shared by both apps: presentational components that
 * take rows and callbacks, so the Kora app and the REST baseline render exactly the same DOM and
 * differ only in where their rows come from. Every rendered row carries `data-row` and its id.
 *
 * Timing marks (design doc, section 11, S0 "Timing"): a `useLayoutEffect` in each list records
 * `first-row` when the list first holds a row after mounting, `complete` when the home list equals
 * the server's rows (P3), and `row-added` when a row appears that the list did not hold before
 * (the written row, P6).
 */
import { type ReactNode, useLayoutEffect, useRef } from 'react'
import './parity-types'
import './app.css'

declare module 'react' {
	interface HTMLAttributes<T> {
		/** Element Timing API identifier (the probe reads the heading's render time). */
		elementtiming?: string
	}
}

export interface Row {
	id: string
	title: string
}

export type Route =
	| { name: 'home' }
	| { name: 'course'; courseId: string; title: string }
	| { name: 'lesson'; lessonId: string; title: string }

function mark(name: string, detail: { screen?: string; id?: string }): void {
	window.__parity?.mark(name, detail)
}

function sameRows(expected: ReadonlyArray<[string, string]>, rows: readonly Row[]): boolean {
	if (expected.length !== rows.length) return false
	return expected.every(([id, title], index) => {
		const row = rows[index]
		return row !== undefined && row.id === id && row.title === title
	})
}

/** A list with the benchmark's timing marks. `screen` names it in the marks. */
export function RowList({
	screen,
	rows,
	onOpen,
}: {
	screen: string
	rows: readonly Row[]
	onOpen?: (row: Row) => void
}): ReactNode {
	const state = useRef<{ first: boolean; complete: boolean; seen: Set<string> | null }>({
		first: false,
		complete: false,
		seen: null,
	})
	useLayoutEffect(() => {
		const current = state.current
		if (!current.first && rows.length > 0) {
			current.first = true
			mark('first-row', { screen })
		}
		const expected = screen === 'home' ? window.__parityConfig?.expectHome : undefined
		if (!current.complete && expected !== undefined && sameRows(expected, rows)) {
			current.complete = true
			mark('complete', { screen })
		}
		if (current.seen === null) {
			current.seen = new Set(rows.map((row) => row.id))
			return
		}
		for (const row of rows) {
			if (!current.seen.has(row.id)) {
				current.seen.add(row.id)
				mark('row-added', { screen, id: row.id })
			}
		}
	})
	return (
		<ul className="rows" data-list={screen}>
			{rows.map((row) => (
				<li key={row.id} data-row={row.id}>
					{onOpen ? (
						<button
							type="button"
							data-action={`open-${screen}`}
							data-id={row.id}
							onClick={() => onOpen(row)}
						>
							{row.title}
						</button>
					) : (
						<span>{row.title}</span>
					)}
				</li>
			))}
		</ul>
	)
}

/** The app frame. Its heading is the "first paint of the app" (P1), not a loading placeholder. */
export function AppShell({
	route,
	onHome,
	children,
}: {
	route: Route
	onHome: () => void
	children: ReactNode
}): ReactNode {
	useLayoutEffect(() => {
		mark('shell-mounted', {})
	}, [])
	return (
		<div className="shell" data-app-shell="">
			<header>
				<h1 elementtiming="app-shell">Parity LMS</h1>
				<nav>
					<button
						type="button"
						data-action="home"
						disabled={route.name === 'home'}
						onClick={onHome}
					>
						Home
					</button>
				</nav>
			</header>
			<main>{children}</main>
		</div>
	)
}

export function HomeScreen({
	courses,
	onOpen,
}: {
	courses: readonly Row[]
	onOpen: (row: Row) => void
}): ReactNode {
	return (
		<section>
			<h2>Courses</h2>
			<RowList screen="home" rows={courses} onOpen={onOpen} />
		</section>
	)
}

export function CourseScreen({
	title,
	lessons,
	onOpen,
}: {
	title: string
	lessons: readonly Row[]
	onOpen: (row: Row) => void
}): ReactNode {
	return (
		<section>
			<h2>{title}</h2>
			<RowList screen="course" rows={lessons} onOpen={onOpen} />
		</section>
	)
}

export function LessonScreen({
	lesson,
	questions,
	progress,
	onMarkDone,
}: {
	lesson: Row | null
	questions: readonly Row[]
	progress: readonly Row[]
	onMarkDone: () => void
}): ReactNode {
	return (
		<section>
			<RowList screen="lesson" rows={lesson === null ? [] : [lesson]} />
			<h3>Questions</h3>
			<RowList screen="questions" rows={questions} />
			<h3>My progress</h3>
			<RowList screen="progress" rows={progress} />
			<button type="button" data-action="mark-done" disabled={lesson === null} onClick={onMarkDone}>
				Mark done
			</button>
		</section>
	)
}

/** Narrow a record from either data source to a row. */
export function toRow(record: { id: unknown; title?: unknown }): Row {
	return { id: String(record.id), title: String(record.title ?? '') }
}

/** The fields a "Mark done" write sets, for both apps (the baseline's server sets the same). */
export function progressFields(
	school: string,
	userId: string,
	lessonId: string,
): Record<string, string | number> {
	return {
		schoolId: school,
		ownerId: userId,
		parentId: lessonId,
		title: `Done by ${userId}`,
		body: '',
		status: 'done',
		score: 100,
		position: 0,
	}
}
