import {
	type FormDraftFieldInput,
	type FormDraftOptions,
	createFormDraft,
	describeFormDraftInput,
	formDraftAppInfo,
	isSecretFormDraftInput,
} from '@korajs/core/bindings'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useOptionalKoraContext } from '../context/kora-context'

/** What {@link useFormDraft} returns. */
export interface UseFormDraftResult<V extends Record<string, unknown>> {
	/** The form's current values (restored from a draft after a reload, when one exists). */
	values: V
	/** Set one field. */
	setValue<K extends keyof V>(field: K, value: V[K]): void
	/** Set several fields. */
	setValues(update: Partial<V>): void
	/**
	 * Props for an `<input>` / `<textarea>` / `<select>`: `name`, `value`, `onChange` and a
	 * `ref` through which the draft reads the input's `type` (`password` is never drafted),
	 * `autocomplete` and `data-kora-sensitive`. A component whose ref lands on a wrapper is
	 * fine: the form control inside it is read. A field with no resolvable control is not
	 * drafted unless listed in `safe`.
	 */
	bind<K extends keyof V & string>(
		field: K,
	): {
		name: K
		value: V[K]
		onChange: (event: { target: { value: unknown } } | V[K]) => void
		ref: (element: Element | null) => void
	}
	/** Props for a checkbox: `name`, `checked`, `onChange` (reads `checked`) and `ref`. */
	bindChecked<K extends keyof V & string>(
		field: K,
	): {
		name: K
		checked: boolean
		onChange: (event: { target: { checked?: unknown } } | boolean) => void
		ref: (element: Element | null) => void
	}
	/** After a successful submit: remove the draft and reset the form to its initial values. */
	clear(): void
	/** True once a draft was restored into the form (it was then removed from storage). */
	restored: boolean
}

/** A layout effect in the browser (restore before the user can type), an effect elsewhere. */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/** The identity of `options.userId`: unknown (loading), none, a user, or a function. */
function userKeyOf(options: FormDraftOptions): string {
	const given = options.userId
	if (typeof given === 'function') return 'function'
	if (given === undefined) return 'userId' in options ? 'unknown' : 'none'
	return given === null ? 'none' : `user:${given}`
}

function isChangeEvent(value: unknown): value is { target: { value: unknown } } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'target' in value &&
		typeof (value as { target?: unknown }).target === 'object'
	)
}

/**
 * Keep a form's input across the reload a new version of the app asks for (version gate).
 * Opt-in per form: nothing is stored unless a form calls it, and only the `fields` it lists
 * are drafted. Never drafted, even when listed: password inputs, inputs marked
 * `data-kora-sensitive`, `t.secret()` fields of `collection`, and `sensitive` fields
 * (`allowSensitive` overrides, discouraged), and fields with no resolvable input unless
 * `safe`. When the app enables encryption no draft is stored at all. A restored draft is
 * removed at once; call `clearFormDrafts(app)` (from `korajs`) on sign-out.
 *
 * With users, pass `userId`: the id once the session loaded, `null` when signed out, and
 * `undefined` while it is still loading (nothing is restored or saved until it is known;
 * the draft is restored when it becomes known, keeping what was typed meanwhile).
 *
 * @param formKey - Unique per form (per record for edit forms: `edit-todo:${id}`)
 * @param initial - The form's initial values
 * @param options - `fields` to draft, `collection`, `sensitive`, `allowSensitive`, `safe`,
 *   `userId`
 *
 * @example
 * ```tsx
 * const draft = useFormDraft('new-todo', { title: '' }, { fields: ['title'], collection: 'todos' })
 * <input {...draft.bind('title')} />
 * // after `await addTodo.mutateAsync(draft.values)`: draft.clear()
 * ```
 */
export function useFormDraft<V extends Record<string, unknown>>(
	formKey: string,
	initial: V,
	options: FormDraftOptions<keyof V & string>,
): UseFormDraftResult<V> {
	const context = useOptionalKoraContext()
	const app = context?.app ?? null
	const identityKey = JSON.stringify([
		formKey,
		options.fields,
		options.collection ?? null,
		options.sensitive ?? [],
		options.allowSensitive ?? [],
		options.safe ?? [],
	])
	const userKey = userKeyOf(options)
	const optionsKey = `${identityKey}|${userKey}`
	// biome-ignore lint/correctness/useExhaustiveDependencies: optionsKey captures every option
	const draft = useMemo(
		() => createFormDraft(formKey, options, () => formDraftAppInfo(app)),
		[optionsKey, app],
	)
	// biome-ignore lint/correctness/useExhaustiveDependencies: optionsKey captures the fields
	const fields = useMemo(() => [...options.fields], [optionsKey])
	const initialRef = useRef(initial)
	const latestInitial = useRef(initial)
	latestInitial.current = initial
	// The state the restore effect set (restored or reset values): never written back as is.
	const awaiting = useRef<V | null>(null)
	const restoredFor = useRef<{
		draft: ReturnType<typeof createFormDraft<keyof V & string>>
		values: Partial<Record<keyof V & string, unknown>> | null
		identityKey: string
		userKey: string
	} | null>(null)
	const [values, setValuesState] = useState<V>(initial)
	const [restored, setRestored] = useState(false)
	const valuesRef = useRef(values)
	valuesRef.current = values
	const elements = useRef(new Map<string, Element>())
	// Fields ever seen bound to a password or sensitive input, kept across draft identities.
	const secretFields = useRef(new Set<string>())
	const ready = useRef(false)
	const lastInputs = useRef('')

	const inputs = useCallback(
		(field: string): FormDraftFieldInput | undefined =>
			describeFormDraftInput(elements.current.get(field)),
		[],
	)

	// Observe the inputs on every commit, before any save: a field seen as a password once
	// (a "show password" toggle before the first keystroke included) is never drafted.
	const noteInputs = useCallback((): void => {
		for (const field of fields) {
			const input = inputs(field)
			if (input !== undefined && isSecretFormDraftInput(input)) secretFields.current.add(field)
		}
		for (const field of secretFields.current) {
			draft.noteInput(field as keyof V & string, { type: 'password' })
		}
	}, [draft, fields, inputs])
	useIsomorphicLayoutEffect(() => {
		noteInputs()
	})

	// Restore once the inputs are mounted (their types decide what may be restored). A new
	// draft identity (another form key or user) starts from the form's initial values: the
	// previous form's input is never written under the new key or user.
	useIsomorphicLayoutEffect(() => {
		// First mount: anything typed before this ran is kept. The session finished loading
		// (unknown user to a known one, same form): kept too. A new identity: start over.
		const previous = restoredFor.current
		const keep =
			previous === null || (previous.userKey === 'unknown' && previous.identityKey === identityKey)
		const base = keep ? valuesRef.current : latestInitial.current
		initialRef.current = latestInitial.current
		// Restoring consumes the stored draft. React StrictMode runs this effect twice for one
		// mount: the second run reuses what the first one restored for the same draft.
		const cached = previous?.draft === draft ? previous.values : undefined
		const draftValues = cached !== undefined ? cached : draft.restore(inputs)
		restoredFor.current = { draft, values: draftValues, identityKey, userKey }
		const next = { ...base, ...(draftValues ?? {}) } as V
		awaiting.current = next
		valuesRef.current = next
		setValuesState(next)
		setRestored(draftValues !== null)
		ready.current = true
	}, [draft, inputs])

	// Save on every change (a session copy of the listed, non-sensitive fields). A form back
	// at its initial values has nothing to keep: the draft is removed instead.
	const persist = useCallback(
		(current: V): void => {
			const unchanged = fields.every((field) =>
				Object.is(current[field], initialRef.current[field]),
			)
			if (unchanged) draft.clear()
			else draft.save(current as Partial<Record<keyof V & string, unknown>>, inputs)
		},
		[draft, inputs, fields],
	)
	useEffect(() => {
		if (!ready.current) return
		if (awaiting.current !== null) {
			// Until the restored (or reset) state renders, `values` is the previous form's.
			// That state itself is consumed: written again only after the next change.
			if (values === awaiting.current) awaiting.current = null
			return
		}
		persist(values)
	}, [persist, values])

	// An input that became a password (or sensitive) input is dropped from the draft at once.
	useEffect(() => {
		const signature = fields
			.map((field) => {
				const input = inputs(field)
				return `${field}:${input?.type ?? ''}:${input?.autocomplete ?? ''}:${input?.sensitive ? 1 : 0}`
			})
			.join('|')
		if (signature === lastInputs.current) return
		const first = lastInputs.current === ''
		lastInputs.current = signature
		// The first look only records the inputs; a restored state is not written back.
		if (!first && ready.current && awaiting.current === null) persist(valuesRef.current)
	})

	// The reload a new build asks for: save the latest values synchronously first.
	useEffect(() => {
		const events = context?.events
		if (!events) return
		return events.on('app:before-build-reload', () => persist(valuesRef.current))
	}, [context?.events, persist])

	const setValue = useCallback(<K extends keyof V>(field: K, value: V[K]): void => {
		setValuesState((current) => ({ ...current, [field]: value }))
	}, [])
	const setValues = useCallback((update: Partial<V>): void => {
		setValuesState((current) => ({ ...current, ...update }))
	}, [])
	const clear = useCallback((): void => {
		draft.clear()
		setValuesState(initialRef.current)
		setRestored(false)
	}, [draft])

	const bind = useCallback(
		<K extends keyof V & string>(field: K) => ({
			name: field,
			value: values[field],
			onChange: (eventOrValue: { target: { value: unknown } } | V[K]) => {
				setValue(field, valueFrom(eventOrValue) as V[K])
			},
			ref: (element: Element | null) => {
				if (element) {
					elements.current.set(field, element)
					const input = describeFormDraftInput(element)
					if (input !== undefined && isSecretFormDraftInput(input)) {
						secretFields.current.add(field)
					}
				} else elements.current.delete(field)
			},
		}),
		[setValue, values],
	)

	const bindChecked = useCallback(
		<K extends keyof V & string>(field: K) => ({
			name: field,
			checked: Boolean(values[field]),
			onChange: (eventOrValue: { target: { checked?: unknown } } | boolean) => {
				setValue(field, valueFrom(eventOrValue, true) as V[K])
			},
			ref: (element: Element | null) => {
				if (element) elements.current.set(field, element)
				else elements.current.delete(field)
			},
		}),
		[setValue, values],
	)

	return { values, setValue, setValues, bind, bindChecked, clear, restored }
}

/** The value of a change event (a checkbox's `checked`), or the value passed directly. */
function valueFrom(eventOrValue: unknown, checkbox = false): unknown {
	if (!isChangeEvent(eventOrValue)) return eventOrValue
	const target = eventOrValue.target as { type?: unknown; checked?: unknown; value?: unknown }
	if (checkbox || target.type === 'checkbox') return Boolean(target.checked)
	return target.value
}
