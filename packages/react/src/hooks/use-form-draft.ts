import {
	type FormDraftFieldInput,
	type FormDraftOptions,
	createFormDraft,
	formDraftAppInfo,
} from '@korajs/core/bindings'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
	 * `ref` through which the draft reads the input's `type` (`password` is never drafted)
	 * and `data-kora-sensitive`.
	 */
	bind<K extends keyof V & string>(
		field: K,
	): {
		name: K
		value: V[K]
		onChange: (event: { target: { value: unknown } } | V[K]) => void
		ref: (element: Element | null) => void
	}
	/** After a successful submit: remove the draft and reset the form to its initial values. */
	clear(): void
	/** True once a draft was restored into the form (it was then removed from storage). */
	restored: boolean
}

function describeInput(element: Element | undefined): FormDraftFieldInput | undefined {
	if (!element) return undefined
	return {
		type: element.getAttribute('type'),
		sensitive: element.hasAttribute('data-kora-sensitive'),
	}
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
 * (`allowSensitive` overrides, discouraged). When the app enables encryption no draft is
 * stored at all. A restored draft is removed at once; call `clearFormDrafts(dbName)` (from
 * `korajs`) on sign-out.
 *
 * @param formKey - Unique per form (per record for edit forms: `edit-todo:${id}`)
 * @param initial - The form's initial values
 * @param options - `fields` to draft, `collection`, `sensitive`, `allowSensitive`, `userId`
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
	const optionsKey = JSON.stringify([
		formKey,
		options.fields,
		options.collection ?? null,
		options.sensitive ?? [],
		options.allowSensitive ?? [],
		options.userId ?? null,
	])
	// biome-ignore lint/correctness/useExhaustiveDependencies: optionsKey captures every option
	const draft = useMemo(
		() => createFormDraft(formKey, options, () => formDraftAppInfo(app)),
		[optionsKey, app],
	)
	// biome-ignore lint/correctness/useExhaustiveDependencies: optionsKey captures the fields
	const fields = useMemo(() => [...options.fields], [optionsKey])
	const initialRef = useRef(initial)
	const [values, setValuesState] = useState<V>(initial)
	const [restored, setRestored] = useState(false)
	const valuesRef = useRef(values)
	valuesRef.current = values
	const elements = useRef(new Map<string, Element>())
	const ready = useRef(false)
	const restoredRef = useRef<V | null>(null)
	const lastInputs = useRef('')

	const inputs = useCallback(
		(field: string): FormDraftFieldInput | undefined => describeInput(elements.current.get(field)),
		[],
	)

	// Restore once the inputs are mounted (their types decide what may be restored).
	useEffect(() => {
		ready.current = false
		const draftValues = draft.restore(inputs)
		if (draftValues) {
			const merged = { ...valuesRef.current, ...draftValues }
			// Consumed: these values are not written back until the user changes something.
			restoredRef.current = merged
			setValuesState(merged)
			setRestored(true)
		}
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
		if (!ready.current || values === restoredRef.current) return
		persist(values)
	}, [persist, values])

	// An input that became a password (or sensitive) input is dropped from the draft at once.
	useEffect(() => {
		const signature = fields
			.map((field) => {
				const input = inputs(field)
				return `${field}:${input?.type ?? ''}:${input?.sensitive ? 1 : 0}`
			})
			.join('|')
		if (signature === lastInputs.current) return
		lastInputs.current = signature
		if (ready.current) persist(valuesRef.current)
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
				const next = isChangeEvent(eventOrValue)
					? (eventOrValue.target.value as V[K])
					: (eventOrValue as V[K])
				setValue(field, next)
			},
			ref: (element: Element | null) => {
				if (element) elements.current.set(field, element)
				else elements.current.delete(field)
			},
		}),
		[setValue, values],
	)

	return { values, setValue, setValues, bind, clear, restored }
}
