import {
	type FormDraftFieldInput,
	type FormDraftOptions,
	cloneFormValues,
	createFormDraft,
	describeFormDraftInput,
	formDraftAppInfo,
	formValuesEqual,
	mergeRestoredDraft,
} from '@korajs/core/bindings'
import { inject, onMounted, onUnmounted, onUpdated, reactive, ref, toValue, watch } from 'vue'
import type { MaybeRefOrGetter, Ref, UnwrapNestedRefs } from 'vue'
import { koraContextKey } from '../context'

/** What {@link useFormDraft} returns. */
export interface UseFormDraftResult<V extends Record<string, unknown>> {
	/** The form's values (bind with `v-model="draft.values.title"`). */
	values: UnwrapNestedRefs<V>
	/**
	 * A template ref for a field's input (`:ref="draft.fieldRef('title')"`): the draft reads
	 * its `type` (`password` is never drafted), `autocomplete` and `data-kora-sensitive`. On a
	 * component, the form control inside its root element is read. A field with no resolvable
	 * control is not drafted unless listed in `safe`.
	 */
	fieldRef(field: keyof V & string): (element: unknown) => void
	/** After a successful submit: remove the draft and reset the form. */
	clear(): void
	/** True once a draft was restored into the form (it was then removed from storage). */
	restored: Ref<boolean>
}

/**
 * Options of the Vue {@link useFormDraft}: `userId` may be a ref or a getter (the signed-in
 * user's id, `null` signed out, `undefined` while the session loads).
 */
export type VueFormDraftOptions<F extends string = string> = Omit<FormDraftOptions<F>, 'userId'> & {
	userId?: MaybeRefOrGetter<string | null | undefined>
}

/** The part of `MutationObserver` the composable uses (structural: no DOM lib needed). */
type MutationObserverLike = new (
	callback: () => void,
) => {
	observe(
		target: unknown,
		options: { attributes: boolean; subtree: boolean; attributeFilter: string[] },
	): void
	disconnect(): void
}

/** No user was known yet (the session never finished loading in this form). */
const NO_USER_YET = Symbol('no user yet')

/** The element a template ref points at: the element, or a component's root element. */
function refElement(target: unknown): unknown {
	if (target && typeof target === 'object' && '$el' in target) {
		return (target as { $el?: unknown }).$el
	}
	return target
}

/**
 * Keep a form's input across the reload a new version of the app asks for (version gate).
 * Same rules as `useFormDraft` of `@korajs/react`: opt-in per form, only the listed
 * `fields`; never password inputs, `data-kora-sensitive` inputs, `t.secret()` fields of
 * `collection` or `sensitive` fields (unless `allowSensitive`), fields with no resolvable
 * input unless `safe`; nothing at all when the app enables encryption; a restored draft is
 * removed at once. `userId` (a value, ref or getter) is `undefined` while the session loads:
 * the draft is restored once the user is known, keeping what was typed meanwhile; another
 * user's draft is removed and the form starts over.
 *
 * @example
 * ```vue
 * const draft = useFormDraft('new-todo', { title: '' }, { fields: ['title'], collection: 'todos' })
 * <input v-model="draft.values.title" :ref="draft.fieldRef('title')" />
 * ```
 */
export function useFormDraft<V extends Record<string, unknown>>(
	formKey: string,
	initial: V,
	options: VueFormDraftOptions<keyof V & string>,
): UseFormDraftResult<V> {
	const contextRef = inject(koraContextKey, null)
	const { userId: givenUser, ...rest } = options
	const hasUsers = 'userId' in options
	const currentUser = (): string | null | undefined => (hasUsers ? toValue(givenUser) : null)
	const draft = createFormDraft(formKey, { ...rest, userId: currentUser }, () =>
		formDraftAppInfo(contextRef?.value?.app ?? null),
	)
	const fields = [...options.fields]
	// The baseline is a deep copy: editing nested values never changes it.
	const baseline = cloneFormValues(initial)
	const values = reactive(cloneFormValues(initial)) as UnwrapNestedRefs<V>
	const restored = ref(false)
	const elements = new Map<string, unknown>()
	let ready = false
	let skipNext = false
	let lastInputs = ''

	const inputs = (field: string): FormDraftFieldInput | undefined =>
		describeFormDraftInput(elements.get(field))
	const snapshot = (): Record<string, unknown> => ({ ...(values as Record<string, unknown>) })
	const persist = (): void => {
		// A user change the watcher has not seen yet (a plain getter): handle it first, never
		// store these values under the new user.
		if (syncUser()) return
		const current = snapshot()
		const unchanged = fields.every((field) => formValuesEqual(current[field], baseline[field]))
		if (unchanged) draft.clear()
		else draft.save(current as Partial<Record<keyof V & string, unknown>>, inputs)
	}
	const inputSignature = (): string =>
		fields
			.map((field) => {
				const input = inputs(field)
				return `${field}:${input?.type ?? ''}:${input?.autocomplete ?? ''}:${input?.sensitive ? 1 : 0}`
			})
			.join('|')

	// The last user the form was known to belong to (NO_USER_YET before any): a loading
	// state in between never hides an account change (alice, loading, bob resets the form).
	let lastKnownUser: string | null | typeof NO_USER_YET = NO_USER_YET
	/**
	 * Apply the current user to the form: the first known user (or the same one again)
	 * restores their draft over the fields not typed meanwhile; another user resets the form
	 * and restores theirs. True when the form's values changed.
	 */
	const syncUser = (): boolean => {
		const user = currentUser()
		if (user === undefined || user === lastKnownUser) return false
		const accountChanged = lastKnownUser !== NO_USER_YET
		lastKnownUser = user
		const before = snapshot()
		const base = accountChanged ? cloneFormValues(baseline) : before
		const draftValues = draft.restore(inputs)
		const next = mergeRestoredDraft(
			base as Record<string, unknown>,
			baseline as Record<string, unknown>,
			draftValues ?? {},
		)
		restored.value = draftValues !== null
		const changed = fields.some((field) => !formValuesEqual(before[field], next[field]))
		if (!changed) return false
		// Consumed: not written back until the user changes something.
		skipNext = true
		Object.assign(values, next)
		return true
	}
	// Observe the inputs before any save (mount, every update, every ref): a field seen as a
	// password once ("show password" toggled before the first keystroke) is never drafted.
	const noteInputs = (): void => {
		for (const field of fields) draft.noteInput(field, inputs(field))
	}
	onMounted(() => {
		noteInputs()
		syncUser()
		lastInputs = inputSignature()
		ready = true
	})
	// The session finished loading: restore the user's draft (what was typed meanwhile is
	// kept). Another user: the previous user's input never carries over.
	watch(currentUser, () => {
		if (ready) syncUser()
	})
	watch(
		values,
		() => {
			if (!ready) return
			if (skipNext) {
				skipNext = false
				return
			}
			persist()
		},
		{ deep: true },
	)
	// An input that became a password (or sensitive) input is dropped from the draft at once.
	onUpdated(() => {
		noteInputs()
		const signature = inputSignature()
		if (signature === lastInputs) return
		lastInputs = signature
		if (ready) persist()
	})
	const events = contextRef?.value?.events
	const off = events?.on('app:before-build-reload', () => persist())
	// Attribute changes Vue does not re-render this component for (a wrapper in a parent
	// component gaining data-kora-sensitive, a type switch in a child): observed directly.
	const observers = new Map<string, { disconnect(): void }>()
	const observe = (field: string, element: unknown): void => {
		observers.get(field)?.disconnect()
		observers.delete(field)
		const Observer = (globalThis as { MutationObserver?: MutationObserverLike }).MutationObserver
		if (!Observer || typeof (element as { nodeType?: unknown })?.nodeType !== 'number') return
		try {
			const observer = new Observer(() => {
				draft.noteInput(field, inputs(field))
				if (ready) persist()
			})
			observer.observe(element, {
				attributes: true,
				subtree: true,
				attributeFilter: ['type', 'autocomplete', 'data-kora-sensitive'],
			})
			for (
				let ancestor = (element as { parentElement?: unknown }).parentElement;
				ancestor;
				ancestor = (ancestor as { parentElement?: unknown }).parentElement
			) {
				observer.observe(ancestor, {
					attributes: true,
					subtree: false,
					attributeFilter: ['data-kora-sensitive'],
				})
			}
			observers.set(field, observer)
		} catch {
			// No observer: the next update or input re-checks.
		}
	}
	onUnmounted(() => {
		off?.()
		for (const observer of observers.values()) observer.disconnect()
		observers.clear()
	})

	return {
		values,
		fieldRef: (field) => (target) => {
			const element = refElement(target)
			if (element) {
				if (elements.get(field) !== element) observe(field, element)
				elements.set(field, element)
				draft.noteInput(field, inputs(field))
			} else {
				elements.delete(field)
				observers.get(field)?.disconnect()
				observers.delete(field)
			}
		},
		clear: () => {
			draft.clear()
			Object.assign(values, cloneFormValues(baseline))
			restored.value = false
		},
		restored,
	}
}
