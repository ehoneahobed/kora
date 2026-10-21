import {
	type FormDraftFieldInput,
	type FormDraftOptions,
	cloneFormValues,
	createFormDraft,
	formDraftAppInfo,
} from '@korajs/core/bindings'
import { inject, onMounted, onUnmounted, onUpdated, reactive, ref, watch } from 'vue'
import type { Ref, UnwrapNestedRefs } from 'vue'
import { koraContextKey } from '../context'

/** What {@link useFormDraft} returns. */
export interface UseFormDraftResult<V extends Record<string, unknown>> {
	/** The form's values (bind with `v-model="draft.values.title"`). */
	values: UnwrapNestedRefs<V>
	/**
	 * A template ref for a field's input (`:ref="draft.fieldRef('title')"`): the draft reads
	 * its `type` (`password` is never drafted) and `data-kora-sensitive`.
	 */
	fieldRef(field: keyof V & string): (element: unknown) => void
	/** After a successful submit: remove the draft and reset the form. */
	clear(): void
	/** True once a draft was restored into the form (it was then removed from storage). */
	restored: Ref<boolean>
}

function describeInput(element: Element | undefined): FormDraftFieldInput | undefined {
	if (!element) return undefined
	return {
		type: element.getAttribute('type'),
		sensitive: element.hasAttribute('data-kora-sensitive'),
	}
}

/**
 * Keep a form's input across the reload a new version of the app asks for (version gate).
 * Same rules as `useFormDraft` of `@korajs/react`: opt-in per form, only the listed
 * `fields`; never password inputs, `data-kora-sensitive` inputs, `t.secret()` fields of
 * `collection` or `sensitive` fields (unless `allowSensitive`); nothing at all when the app
 * enables encryption; a restored draft is removed at once.
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
	options: FormDraftOptions<keyof V & string>,
): UseFormDraftResult<V> {
	const contextRef = inject(koraContextKey, null)
	const draft = createFormDraft(formKey, options, () =>
		formDraftAppInfo(contextRef?.value?.app ?? null),
	)
	const fields = [...options.fields]
	// The baseline is a deep copy: editing nested values never changes it.
	const baseline = cloneFormValues(initial)
	const values = reactive(cloneFormValues(initial)) as UnwrapNestedRefs<V>
	const restored = ref(false)
	const elements = new Map<string, Element>()
	let ready = false
	let skipNext = false
	let lastInputs = ''

	const inputs = (field: string): FormDraftFieldInput | undefined =>
		describeInput(elements.get(field))
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
				return `${field}:${input?.type ?? ''}:${input?.sensitive ? 1 : 0}`
			})
			.join('|')

	onMounted(() => {
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
		lastInputs = inputSignature()
		ready = true
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
		fieldRef: (field) => (element) => {
			if (element instanceof Element) elements.set(field, element)
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
