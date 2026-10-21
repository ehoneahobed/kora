import {
	type FormDraftFieldInput,
	type FormDraftOptions,
	cloneFormValues,
	createFormDraft,
	describeFormDraftInput,
	formDraftAppInfo,
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
		const current = snapshot()
		const unchanged = fields.every(
			(field) => JSON.stringify(current[field]) === JSON.stringify(baseline[field]),
		)
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

	const restoreNow = (): void => {
		const draftValues = draft.restore(inputs)
		if (draftValues) {
			const current = snapshot()
			const changes = Object.entries(draftValues).some(
				([field, value]) => !Object.is(current[field], value),
			)
			// Consumed: not written back until the user changes something.
			if (changes) skipNext = true
			Object.assign(values, draftValues)
			restored.value = true
		}
	}
	onMounted(() => {
		restoreNow()
		lastInputs = inputSignature()
		ready = true
	})
	// The session finished loading: restore the user's draft (what was typed meanwhile is
	// kept). Another user: the previous user's input never carries over.
	watch(currentUser, (next, previous) => {
		if (!ready || next === undefined || next === previous) return
		const before = JSON.stringify(snapshot())
		if (previous !== undefined) {
			Object.assign(values, cloneFormValues(baseline))
			restored.value = false
		}
		const draftValues = draft.restore(inputs)
		if (draftValues) {
			Object.assign(values, draftValues)
			restored.value = true
		}
		// One watcher run for both changes: not written back until the user changes something.
		if (JSON.stringify(snapshot()) !== before) skipNext = true
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
		const signature = inputSignature()
		if (signature === lastInputs) return
		lastInputs = signature
		if (ready) persist()
	})
	const events = contextRef?.value?.events
	const off = events?.on('app:before-build-reload', () => persist())
	onUnmounted(() => off?.())

	return {
		values,
		fieldRef: (field) => (target) => {
			const element = refElement(target)
			if (element) elements.set(field, element)
			else elements.delete(field)
		},
		clear: () => {
			draft.clear()
			Object.assign(values, cloneFormValues(baseline))
			restored.value = false
		},
		restored,
	}
}
