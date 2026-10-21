import type { SchemaDefinition } from '../types'

/**
 * Form drafts: keep what the user was typing across the reload a new build asks for
 * (version gate, `docs/design/version-gate.md` section 6.1). Opt-in per form; the framework
 * has no default-on draft behaviour and persists nothing unless a form calls a
 * `useFormDraft` binding (React, Vue, Svelte), which builds on this controller.
 *
 * Privacy rules:
 * 1. Only the fields a form lists are drafted (an allow-list).
 * 2. Never drafted, even when listed: a field bound to an `<input type="password">` or one
 *    marked `data-kora-sensitive`, a schema field declared `t.secret()`, and a field the app
 *    marks `sensitive`; unless named in `allowSensitive` (discouraged).
 * 3. When the app enables encryption, nothing is stored at all (no plaintext copy of what
 *    Kora encrypts); the form is simply not restored after a reload.
 * 4. A draft is removed as soon as it is restored; every draft of the database is removed
 *    on sign-out or a change of user ({@link clearFormDrafts}); a draft written under another
 *    user id is ignored and removed.
 */

/** Prefix of every draft key of database `dbName` (one `sessionStorage` key per form). */
export function formDraftPrefix(dbName: string): string {
	return `kora-draft:${dbName}:`
}

/** What a binding knows about the input a field is bound to. */
export interface FormDraftFieldInput {
	/** The input's `type` attribute (`password` is never drafted). */
	type?: string | null
	/** The input carries `data-kora-sensitive`. */
	sensitive?: boolean
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
	/** Fields that must never be drafted (health answers, identifiers, ...). */
	sensitive?: readonly string[]
	/** Draft these sensitive fields anyway. Discouraged: a plain session copy of the value. */
	allowSensitive?: readonly string[]
	/**
	 * The signed-in user the draft belongs to. A draft written under another user is never
	 * restored (it is removed).
	 */
	userId?: string | null
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
	const sensitive = new Set<string>(options.sensitive ?? [])
	const allowSensitive = new Set<string>(options.allowSensitive ?? [])
	const userId = options.userId ?? null
	// Rule 3: with encryption enabled, never write a plaintext copy anywhere.
	const isEnabled = (): boolean => storage !== null && !info().encrypted

	const isDraftable = (field: F, input?: FormDraftFieldInput): boolean => {
		if (!listed.has(field)) return false
		if (allowSensitive.has(field)) return true
		if (sensitive.has(field)) return false
		if (input?.sensitive === true) return false
		if (typeof input?.type === 'string' && input.type.toLowerCase() === 'password') return false
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
			picked[field] = values[field]
		}
		return picked
	}

	return {
		isEnabled,
		isDraftable,
		restore(inputs) {
			if (!storage) return null
			let raw: string | null = null
			try {
				raw = storage.getItem(key)
			} catch {
				return null
			}
			if (raw === null) return null
			// Rule 4: consumed on restore, whatever it held.
			remove()
			if (!isEnabled()) return null
			let parsed: StoredDraft | null = null
			try {
				parsed = JSON.parse(raw) as StoredDraft
			} catch {
				return null
			}
			if (parsed?.v !== 1 || typeof parsed.values !== 'object' || parsed.values === null)
				return null
			if ((parsed.user ?? null) !== userId) return null
			const restored = pick(parsed.values as Partial<Record<F, unknown>>, inputs)
			return Object.keys(restored).length > 0 ? restored : null
		},
		save(values, inputs) {
			if (!isEnabled() || !storage) return
			const picked = pick(values, inputs)
			if (Object.keys(picked).length === 0) {
				remove()
				return
			}
			const draft: StoredDraft = { v: 1, user: userId, values: picked }
			try {
				storage.setItem(key, JSON.stringify(draft))
			} catch {
				// Quota or privacy mode: a draft is best effort; the form itself is unaffected.
			}
		},
		clear: remove,
	}
}

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
