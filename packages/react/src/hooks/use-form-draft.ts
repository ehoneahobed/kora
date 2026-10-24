import {
	type FormDraftFieldInput,
	type FormDraftOptions,
	createFormDraft,
	describeFormDraftInput,
	formDraftAppInfo,
	isSecretFormDraftInput,
	mergeRestoredDraft,
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
	// A getter is evaluated: the draft follows the user it returns now, so an account switch
	// it reports is a change of identity (reset, then the new user's draft), never a retag.
	if (typeof given === 'function') return keyOfUser(given())
	if (given === undefined) return 'userId' in options ? 'unknown' : 'none'
	return keyOfUser(given)
}

/** The identity key of a resolved user: unknown (loading), none, or a user. */
function keyOfUser(user: string | null | undefined): string {
	if (user === undefined) return 'unknown'
	return user === null ? 'none' : `user:${user}`
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
	const draftRef = useRef(draft)
	draftRef.current = draft
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
	// The last user the form was known to belong to: a loading state in between never hides
	// an account change (alice, then loading, then bob resets the form).
	const lastKnownUser = useRef<string | null>(null)

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
		// (unknown user to the user the form belonged to, or the first one): kept too, and
		// fields typed meanwhile win over the stored draft. Another form or another account
		// (even across a loading state): start over from the initial values.
		const previous = restoredFor.current
		const known = userKey !== 'unknown'
		const accountChanged =
			known && lastKnownUser.current !== null && lastKnownUser.current !== userKey
		const keep =
			previous === null ||
			(previous.identityKey === identityKey &&
				!accountChanged &&
				(previous.userKey === 'unknown' || previous.userKey === userKey))
		if (known) lastKnownUser.current = userKey
		initialRef.current = latestInitial.current
		// Restoring consumes the stored draft. React StrictMode runs this effect twice for one
		// mount: the second run reuses what the first one restored for the same draft.
		const cached = previous?.draft === draft ? previous.values : undefined
		const draftValues = cached !== undefined ? cached : draft.restore(inputs)
		restoredFor.current = { draft, values: draftValues, identityKey, userKey }
		const next = keep
			? mergeRestoredDraft(valuesRef.current, latestInitial.current, draftValues ?? {})
			: ({ ...latestInitial.current, ...(draftValues ?? {}) } as V)
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
			// A userId getter that reports another user than this draft's: never store these
			// values under it (the next render resets the form for that user).
			if (keyOfUser(draft.currentUser()) !== userKey) return
			const unchanged = fields.every((field) =>
				Object.is(current[field], initialRef.current[field]),
			)
			if (unchanged) draft.clear()
			else draft.save(current as Partial<Record<keyof V & string, unknown>>, inputs)
		},
		[draft, inputs, fields, userKey],
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

	// The latest persist, for observers created once per element.
	const persistRef = useRef(persist)
	persistRef.current = persist
	const observers = useRef(
		new Map<string, { element: Element; observer: { disconnect(): void } }>(),
	)
	useEffect(
		() => () => {
			for (const { observer } of observers.current.values()) observer.disconnect()
			observers.current.clear()
		},
		[],
	)
	/**
	 * Track a field's element: note a password at once, and observe attribute changes React
	 * does not re-render this component for (a wrapper in a memoized parent gaining
	 * data-kora-sensitive): the field is re-checked and its stored value dropped at once.
	 */
	const attachField = useCallback((field: string, element: Element | null): void => {
		const previous = observers.current.get(field)
		if (!element) {
			elements.current.delete(field)
			previous?.observer.disconnect()
			observers.current.delete(field)
			return
		}
		elements.current.set(field, element)
		const input = describeFormDraftInput(element)
		if (input !== undefined && isSecretFormDraftInput(input)) secretFields.current.add(field)
		if (previous?.element === element) return
		previous?.observer.disconnect()
		const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver
		if (!Observer) return
		const observer = new Observer(() => {
			const now = describeFormDraftInput(elements.current.get(field))
			if (now !== undefined && isSecretFormDraftInput(now)) secretFields.current.add(field)
			if (ready.current && awaiting.current === null) {
				for (const secret of secretFields.current) {
					draftRef.current.noteInput(secret as keyof V & string, { type: 'password' })
				}
				persistRef.current(valuesRef.current)
			}
		})
		observer.observe(element, {
			attributes: true,
			subtree: true,
			attributeFilter: ['type', 'autocomplete', 'data-kora-sensitive'],
		})
		for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
			observer.observe(ancestor, { attributes: true, attributeFilter: ['data-kora-sensitive'] })
		}
		observers.current.set(field, { element, observer })
	}, [])

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
			ref: (element: Element | null) => attachField(field, element),
		}),
		[setValue, values, attachField],
	)

	const bindChecked = useCallback(
		<K extends keyof V & string>(field: K) => ({
			name: field,
			checked: Boolean(values[field]),
			onChange: (eventOrValue: { target: { checked?: unknown } } | boolean) => {
				setValue(field, valueFrom(eventOrValue, true) as V[K])
			},
			ref: (element: Element | null) => attachField(field, element),
		}),
		[setValue, values, attachField],
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
