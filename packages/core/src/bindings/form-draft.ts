import type { SchemaDefinition } from '../types'

/**
 * Form drafts: keep what the user was typing across the reload a new build asks for
 * (version gate, `docs/design/version-gate.md` section 6.1). Opt-in per form; the framework
 * has no default-on draft behaviour and persists nothing unless a form calls a
 * `useFormDraft` binding (React, Vue, Svelte), which builds on this controller.
 *
 * Privacy rules:
 * 1. Only the fields a form lists are drafted (an allow-list).
 * 2. Never drafted, even when listed: a field bound to a password input (`type="password"`,
 *    or `autocomplete` `current-password`, `new-password`, `one-time-code`, `cc-*`; once
 *    seen, for the life of the form, so a "show password" toggle does not draft it) or one
 *    marked `data-kora-sensitive`, a schema field declared `t.secret()`, and a field the app
 *    marks `sensitive` (a dotted path such as `answers.ssn` removes that nested value);
 *    unless named in `allowSensitive` (discouraged).
 * 3. Fail closed: a listed field whose input cannot be resolved (no `<input>`, `<textarea>`
 *    or `<select>` at or inside the element bound to it, or none bound: values set from
 *    code, components whose ref is a wrapper) is not drafted unless named in `safe`.
 * 4. When the app enables encryption, nothing is stored at all (no plaintext copy of what
 *    Kora encrypts); the form is simply not restored after a reload.
 * 5. A draft is removed as soon as it is restored; every draft of the database is removed
 *    on sign-out or a change of user ({@link clearFormDrafts}); a draft written under
 *    another (known) user id is removed, never restored. While the user is unknown (the
 *    session is still loading: `userId: undefined`), nothing is restored, consumed or saved.
 */

/** Prefix of every draft key of database `dbName` (one `sessionStorage` key per form). */
export function formDraftPrefix(dbName: string): string {
	// Encoded, so a database name containing `:` never prefixes another database's keys.
	return `kora-draft:${encodeURIComponent(dbName)}:`
}

/**
 * A deep copy of form values (a baseline that edits never reach): `structuredClone`, or a
 * JSON round trip where it is missing.
 */
export function cloneFormValues<V>(values: V): V {
	const clone = (globalThis as { structuredClone?: <T>(value: T) => T }).structuredClone
	if (clone) {
		try {
			return clone(values)
		} catch {
			// Values structuredClone refuses (functions): fall back below.
		}
	}
	return JSON.parse(JSON.stringify(values)) as V
}

/** What a binding knows about the input a field is bound to. */
export interface FormDraftFieldInput {
	/** The input's type (`password` is never drafted). */
	type?: string | null
	/** The input's `autocomplete` (password, one-time-code and card tokens are never drafted). */
	autocomplete?: string | null
	/** The input (or an element around it) carries `data-kora-sensitive`. */
	sensitive?: boolean
}

/** The element subset {@link describeFormDraftInput} reads (structural: no DOM lib needed). */
interface ElementLike {
	getAttribute(name: string): string | null
	hasAttribute(name: string): boolean
	matches?(selector: string): boolean
	querySelectorAll?(selector: string): ArrayLike<unknown>
	closest?(selector: string): unknown
}

function isElementLike(value: unknown): value is ElementLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as ElementLike).getAttribute === 'function' &&
		typeof (value as ElementLike).hasAttribute === 'function'
	)
}

const FORM_CONTROL = 'input, textarea, select'

/**
 * Describe the form control a field is bound to: the element itself when it is an
 * `<input>`, `<textarea>` or `<select>`, else the controls inside it (a component whose ref
 * lands on a wrapper). With several, any password or sensitive one makes the field secret.
 * Undefined when no control can be resolved: the field is then not drafted unless `safe`.
 */
export function describeFormDraftInput(element: unknown): FormDraftFieldInput | undefined {
	if (!isElementLike(element)) return undefined
	let controls: ElementLike[] = []
	if (typeof element.matches === 'function' && element.matches(FORM_CONTROL)) {
		controls = [element]
	} else if (typeof element.querySelectorAll === 'function') {
		controls = Array.from(element.querySelectorAll(FORM_CONTROL)).filter(isElementLike)
	}
	if (controls.length === 0) return undefined
	const typeOf = (control: ElementLike): string => {
		const property = (control as { type?: unknown }).type
		const type = typeof property === 'string' ? property : control.getAttribute('type')
		return (type ?? 'text').toLowerCase()
	}
	const secret = controls.find(
		(control) =>
			typeOf(control) === 'password' || isSecretAutocomplete(control.getAttribute('autocomplete')),
	)
	const chosen = secret ?? (controls[0] as ElementLike)
	const sensitive =
		element.hasAttribute('data-kora-sensitive') ||
		controls.some(
			(control) =>
				control.hasAttribute('data-kora-sensitive') ||
				(typeof control.closest === 'function' &&
					control.closest('[data-kora-sensitive]') !== null),
		)
	return {
		type: typeOf(chosen),
		autocomplete: chosen.getAttribute('autocomplete'),
		sensitive,
	}
}

/** Whether `input` is a password (type or autocomplete) or marked sensitive. */
export function isSecretFormDraftInput(input: FormDraftFieldInput): boolean {
	return (
		input.sensitive === true ||
		(typeof input.type === 'string' && input.type.toLowerCase() === 'password') ||
		isSecretAutocomplete(input.autocomplete)
	)
}

/** `autocomplete` tokens of secrets: passwords, one-time codes, payment cards. */
function isSecretAutocomplete(value: string | null | undefined): boolean {
	if (!value) return false
	return value
		.toLowerCase()
		.split(/\s+/)
		.some(
			(token) =>
				token === 'current-password' ||
				token === 'new-password' ||
				token === 'one-time-code' ||
				token.startsWith('cc-'),
		)
}

/** The `Storage` subset drafts use (`sessionStorage` by default). */
export interface FormDraftStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
	readonly length: number
	key(index: number): string | null
}

/** Options shared by every `useFormDraft` binding. */
export interface FormDraftOptions<F extends string = string> {
	/** The fields to draft (an allow-list: a field added to the form later is not drafted). */
	fields: readonly F[]
	/** Schema collection the form writes: its `t.secret()` fields are never drafted. */
	collection?: string
	/**
	 * Fields that must never be drafted (health answers, identifiers, ...). A dotted path
	 * (`answers.ssn`) removes that nested value from a listed object field (in an array of
	 * objects, from each element); sensitivity is otherwise per top-level field.
	 */
	sensitive?: readonly string[]
	/** Draft these sensitive fields anyway. Discouraged: a plain session copy of the value. */
	allowSensitive?: readonly string[]
	/**
	 * Fields drafted even when no `<input>`, `<textarea>` or `<select>` can be resolved for
	 * them (values set from code, components whose ref is a wrapper with no form control).
	 * You vouch that they hold no password or secret; every other check still applies.
	 */
	safe?: readonly string[]
	/**
	 * The signed-in user the draft belongs to: their id, `null` when signed out (or for an
	 * app without users), and `undefined` while the session is still loading (unknown:
	 * nothing is restored, consumed or saved until it is known). A function is read at each
	 * use. A draft written under another known user is removed, never restored.
	 */
	userId?: string | null | (() => string | null | undefined)
}

/** What the controller needs to know about the app. */
export interface FormDraftAppInfo {
	/** Database name the drafts are keyed by. */
	dbName: string
	/** The app enables encryption: no draft is stored (rule 3). */
	encrypted: boolean
	/** The app schema, when known (for `t.secret()` fields). */
	schema: SchemaDefinition | null
}

interface StoredDraft {
	v: 1
	user: string | null
	values: Record<string, unknown>
}

/** A form's draft: restore once, save on change, clear after a successful submit. */
export interface FormDraftController<F extends string = string> {
	/** Whether drafts can be stored at all now (no encryption, storage available). */
	isEnabled(): boolean
	/**
	 * The stored draft's values for the fields that may be drafted, or null. The stored
	 * draft is removed (consumed): the restored values live in the form from now on.
	 */
	restore(
		inputs?: (field: F) => FormDraftFieldInput | undefined,
	): Partial<Record<F, unknown>> | null
	/** Store the draftable fields of `values` (removes the draft when none is left). */
	save(
		values: Partial<Record<F, unknown>>,
		inputs?: (field: F) => FormDraftFieldInput | undefined,
	): void
	/** Remove the stored draft (after a successful submit). */
	clear(): void
	/** Whether `field` may be drafted given its input. */
	isDraftable(field: F, input?: FormDraftFieldInput): boolean
	/**
	 * Record the input a field is bound to as soon as the binding sees it (mount, and every
	 * change of its type), not only when a value is saved: a field ever seen as a password or
	 * sensitive input is never drafted in this form, so a "show password" toggle used before
	 * the first keystroke cannot draft the password.
	 */
	noteInput(field: F, input: FormDraftFieldInput | undefined): void
}

/** `sessionStorage`, or null where it is missing or throws (privacy modes). */
export function defaultFormDraftStorage(): FormDraftStorage | null {
	try {
		const storage = (globalThis as { sessionStorage?: FormDraftStorage }).sessionStorage
		return storage ?? null
	} catch {
		return null
	}
}

/** The `t.secret()` fields of `collection` in `schema`. */
export function secretFieldsOf(
	schema: SchemaDefinition | null,
	collection: string | undefined,
): Set<string> {
	const fields = collection ? schema?.collections[collection]?.fields : undefined
	const secret = new Set<string>()
	if (!fields) return secret
	for (const [name, descriptor] of Object.entries(fields)) {
		if ((descriptor as { kind?: string }).kind === 'secret') secret.add(name)
	}
	return secret
}

/**
 * Create the draft controller of one form.
 *
 * @param formKey - Unique per form, and per record for edit forms (`edit-todo:<id>`)
 * @param options - Fields, sensitivity and user
 * @param app - Database name, encryption and schema of the app (a function: read at each
 *   use, so a schema that becomes known once the store opens is honoured)
 * @param storage - Defaults to `sessionStorage`
 */
export function createFormDraft<F extends string>(
	formKey: string,
	options: FormDraftOptions<F>,
	app: FormDraftAppInfo | (() => FormDraftAppInfo),
	storage: FormDraftStorage | null = defaultFormDraftStorage(),
): FormDraftController<F> {
	const info = (): FormDraftAppInfo => (typeof app === 'function' ? app() : app)
	const key = `${formDraftPrefix(info().dbName)}${formKey}`
	const listed = new Set<string>(options.fields)
	const sensitive = new Set<string>()
	// Dotted `sensitive` entries, per top-level field: nested values removed from the draft.
	const nested = new Map<string, string[][]>()
	for (const entry of options.sensitive ?? []) {
		const path = entry.split('.')
		const head = path[0] ?? entry
		if (path.length === 1) sensitive.add(entry)
		else nested.set(head, [...(nested.get(head) ?? []), path.slice(1)])
	}
	const allowSensitive = new Set<string>(options.allowSensitive ?? [])
	const safe = new Set<string>(options.safe ?? [])
	warnUnlisted(formKey, listed, options)
	// Fields seen bound to a password or sensitive input: never drafted again in this form
	// (a "show password" toggle turns the input into a text input).
	const seenSecret = new Set<string>()
	// Rule 5: undefined while the session is loading (the user is unknown).
	const userOf = (): string | null | undefined => {
		const given = options.userId
		if (typeof given === 'function') return given()
		if ('userId' in options) return given
		return null
	}
	// Rule 4: with encryption enabled, never write a plaintext copy anywhere.
	const isEnabled = (): boolean => storage !== null && !info().encrypted

	const isDraftable = (field: F, input?: FormDraftFieldInput): boolean => {
		if (!listed.has(field)) return false
		if (allowSensitive.has(field)) return true
		if (sensitive.has(field) || seenSecret.has(field)) return false
		if (input === undefined) {
			// Rule 3: no resolvable input, so its type is unknown: drafted only when vouched for.
			if (!safe.has(field)) return false
		} else if (isSecretFormDraftInput(input)) {
			seenSecret.add(field)
			return false
		}
		if (options.collection !== undefined) {
			const schema = info().schema
			// The collection's secret fields are unknown until the store opens: not drafted.
			if (schema === null) return false
			// A collection the schema does not have (misspelled, renamed): fail closed.
			if (!schema.collections[options.collection]) return false
			if (secretFieldsOf(schema, options.collection).has(field)) return false
		}
		return true
	}

	const remove = (): void => {
		if (!storage) return
		try {
			storage.removeItem(key)
		} catch {
			// Storage refused (privacy mode): nothing was stored either.
		}
	}

	const pick = (
		values: Partial<Record<F, unknown>>,
		inputs?: (field: F) => FormDraftFieldInput | undefined,
	): Partial<Record<F, unknown>> => {
		const picked: Partial<Record<F, unknown>> = {}
		for (const field of options.fields) {
			if (!(field in values)) continue
			if (!isDraftable(field, inputs?.(field))) continue
			const paths = nested.get(field)
			picked[field] = paths ? withoutPaths(values[field], paths) : values[field]
		}
		return picked
	}

	return {
		isEnabled,
		isDraftable,
		noteInput(field, input) {
			if (listed.has(field) && input !== undefined && isSecretFormDraftInput(input)) {
				seenSecret.add(field)
			}
		},
		restore(inputs) {
			if (!storage) return null
			// The user is not known yet (session loading): the draft may be theirs. Neither
			// restored nor consumed; the binding restores again once the user is known.
			const user = userOf()
			if (user === undefined) return null
			let raw: string | null = null
			try {
				raw = storage.getItem(key)
			} catch {
				return null
			}
			if (raw === null) return null
			// Encryption enabled: an older plaintext draft is removed, never restored.
			if (!isEnabled()) {
				remove()
				return null
			}
			let parsed: StoredDraft | null = null
			try {
				parsed = JSON.parse(raw) as StoredDraft
			} catch {
				parsed = null
			}
			if (parsed?.v !== 1 || typeof parsed.values !== 'object' || parsed.values === null) {
				remove()
				return null
			}
			// Rule 5: consumed on restore; a known different user's draft is removed unread.
			remove()
			if ((parsed.user ?? null) !== user) return null
			const restored = pick(parsed.values as Partial<Record<F, unknown>>, inputs)
			return Object.keys(restored).length > 0 ? restored : null
		},
		save(values, inputs) {
			if (!isEnabled() || !storage) return
			const user = userOf()
			// Unknown user (session loading): nothing is written that could be attributed wrong.
			if (user === undefined) return
			const picked = pick(values, inputs)
			if (Object.keys(picked).length === 0) {
				remove()
				return
			}
			const draft: StoredDraft = { v: 1, user, values: picked }
			try {
				storage.setItem(key, JSON.stringify(draft))
			} catch {
				// Quota or privacy mode: a draft is best effort; the form itself is unaffected.
			}
		},
		clear: remove,
	}
}

/** A deep copy of `value` without the nested `paths` (each applied to every array element). */
function withoutPaths(value: unknown, paths: string[][]): unknown {
	if (value === null || typeof value !== 'object') return value
	const copy = cloneFormValues(value)
	for (const path of paths) removePath(copy, path)
	return copy
}

function removePath(target: unknown, path: string[]): void {
	const [head, ...rest] = path
	if (head === undefined || target === null || typeof target !== 'object') return
	if (Array.isArray(target) && !/^\d+$/.test(head)) {
		for (const item of target) removePath(item, path)
		return
	}
	const record = target as Record<string, unknown>
	if (rest.length === 0) delete record[head]
	else removePath(record[head], rest)
}

/**
 * Warn (once per entry) about `sensitive`, `allowSensitive` and `safe` entries whose field is
 * not in `fields`: a misspelled entry silently protects nothing.
 */
function warnUnlisted(
	formKey: string,
	listed: ReadonlySet<string>,
	options: Pick<FormDraftOptions, 'sensitive' | 'allowSensitive' | 'safe'>,
): void {
	for (const option of ['sensitive', 'allowSensitive', 'safe'] as const) {
		for (const entry of options[option] ?? []) {
			const field = entry.split('.')[0] ?? entry
			if (listed.has(field)) continue
			const id = `${formKey}|${option}|${entry}`
			if (warnedUnlisted.has(id)) continue
			warnedUnlisted.add(id)
			console.warn(
				`[kora] useFormDraft("${formKey}"): "${entry}" in ${option} is not one of fields (${[...listed].join(', ')}), so it has no effect.`,
			)
		}
	}
}

const warnedUnlisted = new Set<string>()

/**
 * Remove every form draft of database `dbName`: call on sign-out and when the signed-in
 * user changes (the templates' auth wiring does).
 *
 * @returns How many drafts were removed
 */
export function clearFormDrafts(
	dbName: string,
	storage: FormDraftStorage | null = defaultFormDraftStorage(),
): number {
	if (!storage) return 0
	const prefix = formDraftPrefix(dbName)
	const keys: string[] = []
	try {
		for (let i = 0; i < storage.length; i += 1) {
			const key = storage.key(i)
			if (key?.startsWith(prefix)) keys.push(key)
		}
		for (const key of keys) storage.removeItem(key)
	} catch {
		return 0
	}
	return keys.length
}

/**
 * What the drafts need to know about a Kora app (`createApp()` result), read defensively:
 * its database name, whether it enables encryption (`app.encryption`), and its schema once
 * the store is open.
 */
export function formDraftAppInfo(app: unknown): FormDraftAppInfo {
	const candidate = (app ?? {}) as {
		storeInfo?: () => { baseName?: string }
		encryption?: unknown
		getStore?: () => { getSchema?: () => SchemaDefinition }
	}
	let dbName = 'kora-db'
	try {
		dbName = candidate.storeInfo?.().baseName ?? dbName
	} catch {
		// Keep the default.
	}
	let schema: SchemaDefinition | null = null
	try {
		schema = candidate.getStore?.().getSchema?.() ?? null
	} catch {
		// The store is not open yet.
	}
	const encrypted = candidate.encryption !== null && candidate.encryption !== undefined
	return { dbName, encrypted, schema }
}
