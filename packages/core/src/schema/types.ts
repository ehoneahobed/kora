import { SchemaValidationError } from '../errors/errors'
import { encodeStoredText } from '../text/stored-text'
import type {
	BlobRef,
	FieldDescriptor,
	FieldKind,
	FieldMergeStrategy,
	SecretMode,
	TransitionMap,
} from '../types'
import type { FieldKindToType } from './infer'

/**
 * A value a `t.richtext()` field accepts on write: a plain string (stored as a fresh
 * Yjs document holding that text) or Yjs update bytes. Reads always return the Yjs
 * update bytes (`Uint8Array`).
 */
export type RichtextInput = string | Uint8Array | ArrayBuffer

/**
 * Compile-time description of a field, carried by every {@link FieldBuilder} under the
 * `'~field'` key. It exists only in the type system (the property is `declare`d, so it is
 * never present at runtime) and is what makes builders structurally distinct:
 * `t.string()` and `t.string().optional()` are different types, so inference can tell a
 * required field from an optional one.
 */
export interface FieldTypeInfo<
	Kind extends FieldKind,
	Req extends boolean,
	Auto extends boolean,
	Output,
	Input,
> {
	/** The field kind. */
	readonly kind: Kind
	/** Whether the developer must provide the field on insert. */
	readonly required: Req
	/** Whether the framework fills the field (it cannot be written). */
	readonly auto: Auto
	/** The type a read returns for the field (before nullability). */
	readonly output: Output
	/** The type a write accepts for the field (before optionality). */
	readonly input: Input
}

/**
 * The value types of each scalar field kind: what a read returns. `timestamp` is integer
 * milliseconds since the epoch (a `Date` is not accepted; use `date.getTime()`).
 */
export interface ScalarKindToType {
	string: string
	number: number
	boolean: boolean
	timestamp: number
	richtext: Uint8Array
	blob: BlobRef
	secret: string
}

/** The type a scalar field kind accepts on write. */
export interface ScalarKindToInput {
	string: string
	number: number
	boolean: boolean
	timestamp: number
	richtext: RichtextInput
	blob: BlobRef
	secret: string
}

/** A scalar field kind: one whose builder is a plain {@link FieldBuilder}. */
export type ScalarFieldKind = keyof ScalarKindToType

/** The read type a field kind has when its builder declares nothing more specific. */
export type DefaultFieldOutput<Kind extends FieldKind> = FieldKindToType[Kind]

/** The write type a field kind has when its builder declares nothing more specific. */
export type DefaultFieldInput<Kind extends FieldKind> = Kind extends 'richtext'
	? RichtextInput
	: FieldKindToType[Kind]

/**
 * Base field builder implementing the builder pattern for schema field definitions.
 * Each builder is immutable — modifier methods return new builder instances.
 *
 * Type parameters track field metadata at the type level for inference:
 * - Kind: the field kind ('string', 'number', etc.)
 * - Req: whether the field is required (true = required on insert)
 * - Auto: whether the field is auto-populated (true = excluded from insert input)
 * - Output: the type a read returns
 * - Input: the type a write accepts (differs from Output only for richtext)
 *
 * A bare `FieldBuilder` (no type arguments) means "any field builder".
 *
 * @example
 * ```typescript
 * t.string()                    // required string field
 * t.string().optional()         // optional string field
 * t.string().default('hello')   // string with default value
 * t.timestamp().auto()          // auto-populated timestamp
 * ```
 */
export class FieldBuilder<
	Kind extends FieldKind = FieldKind,
	Req extends boolean = boolean,
	Auto extends boolean = boolean,
	Output = DefaultFieldOutput<Kind>,
	Input = Kind extends 'richtext' ? DefaultFieldInput<Kind> : Output,
> {
	/**
	 * Type-only brand (never present at runtime). It makes the builder's kind,
	 * requiredness, auto flag and value types part of its structure, which is what
	 * schema inference reads.
	 */
	declare readonly '~field': FieldTypeInfo<Kind, Req, Auto, Output, Input>

	protected readonly _kind: Kind
	protected readonly _required: boolean
	protected readonly _defaultValue: unknown
	protected readonly _auto: boolean
	protected readonly _mergeStrategy: FieldMergeStrategy | null
	/** Set only through `stamp()`; carried by the modifiers that return a new builder. */
	protected _stamp: 'userId' | null = null

	constructor(
		kind: Kind,
		required = true,
		defaultValue: unknown = undefined,
		auto = false,
		mergeStrategy: FieldMergeStrategy | null = null,
	) {
		this._kind = kind
		this._required = required
		this._defaultValue = defaultValue
		this._auto = auto
		this._mergeStrategy = mergeStrategy
	}

	/** Mark this field as optional (not required on insert; reads may return `null`). */
	optional(): FieldBuilder<Kind, false, Auto, Output, Input> {
		return this.carryStamp(
			new FieldBuilder(this._kind, false, this._defaultValue, this._auto, this._mergeStrategy),
		)
	}

	/**
	 * Set a default value for this field. Implicitly makes the field optional on insert.
	 * The value must be of the field's type (`t.number().default('x')` is a type error).
	 */
	default(value: Input): FieldBuilder<Kind, false, Auto, Output, Input> {
		if (this._stamp) {
			throw new SchemaValidationError(
				'A stamped field gets its value from the server; it cannot also have a default.',
			)
		}
		return new FieldBuilder(this._kind, false, value, this._auto, this._mergeStrategy)
	}

	/**
	 * Mark this field as auto-populated (e.g., createdAt timestamps). Developers cannot
	 * set auto fields; the framework fills `t.timestamp().auto()` with the insert time.
	 */
	auto(): FieldBuilder<Kind, false, true, Output, Input> {
		if (this._stamp) {
			throw new SchemaValidationError('A field cannot be both auto() and stamp().')
		}
		return new FieldBuilder(this._kind, false, undefined, true, this._mergeStrategy)
	}

	/**
	 * Declare a merge strategy for this field.
	 * Controls how concurrent modifications are resolved during sync.
	 *
	 * @param strategy - The merge strategy to use:
	 *   - `'lww'`: Last-write-wins (default for scalar fields)
	 *   - `'counter'`: Sum of deltas from base (for numbers)
	 *   - `'max'`: Keep the maximum value (for numbers/timestamps)
	 *   - `'min'`: Keep the minimum value (for numbers/timestamps)
	 *   - `'union'`: Set-union merge (default for arrays)
	 *   - `'append-only'`: Concatenate additions (for arrays)
	 *   - `'server-authoritative'`: Always prefer the remote/server value
	 */
	merge(strategy: FieldMergeStrategy): FieldBuilder<Kind, Req, Auto, Output, Input> {
		return this.carryStamp(
			new FieldBuilder(this._kind, this._required, this._defaultValue, this._auto, strategy),
		)
	}

	/**
	 * Stamp this string field with the writing user's id: on insert Kora fills it with the
	 * signed-in user (leave it out), the server refuses any other value, and no client may
	 * change it afterwards. Only on collections with `access` rules.
	 *
	 * @example
	 * ```typescript
	 * authorId: t.string().stamp('userId')
	 * ```
	 */
	stamp(
		this: FieldBuilder<'string', boolean, false, Output, Input>,
		source: 'userId',
	): FieldBuilder<'string', false, false, Output, Input> {
		if (this._kind !== 'string') {
			throw new SchemaValidationError('stamp() is only available on t.string() fields.')
		}
		if (source !== 'userId') {
			throw new SchemaValidationError(`stamp() source must be 'userId' (got "${String(source)}").`)
		}
		if (this._auto || this._defaultValue !== undefined) {
			throw new SchemaValidationError(
				'A stamped field gets its value from the server; it cannot be auto() or have a default.',
			)
		}
		const next = new FieldBuilder<'string', false, false, Output, Input>(
			'string',
			false,
			undefined,
			false,
			this._mergeStrategy,
		)
		next._stamp = source
		return next
	}

	/** Copy this builder's stamp onto a builder a modifier returned. */
	private carryStamp<B extends FieldBuilder<Kind, boolean, boolean, Output, Input>>(next: B): B {
		next._stamp = this._stamp
		return next
	}

	/** @internal Build the final FieldDescriptor. Used by defineSchema(). */
	_build(): FieldDescriptor {
		return {
			kind: this._kind,
			required: this._required,
			defaultValue: this._defaultValue,
			auto: this._auto,
			enumValues: null,
			itemKind: null,
			mergeStrategy: this._mergeStrategy,
			transitions: null,
			...(this._stamp ? { stamp: this._stamp } : {}),
		}
	}
}

/**
 * Enum values are stored verbatim (an enum column is not raw text with the stored-text
 * codec), so every value must be text SQLite stores and reads back exactly: no U+0000
 * (SQLite WASM reads TEXT up to a NUL), no lone surrogate (UTF-8 cannot hold one) and no
 * U+FFFF (the stored-text codec's escape). The table's `CHECK` used to refuse such values
 * at write time; with the value domain enforced by validation only (RT-101) the schema
 * refuses them up front.
 */
function assertStorableEnumValues(values: readonly string[]): void {
	for (const value of values) {
		if (typeof value !== 'string' || encodeStoredText(value) !== value) {
			throw new SchemaValidationError(
				`Enum value ${JSON.stringify(value)} cannot be stored: enum values must be well-formed strings without U+0000 or U+FFFF.`,
				{ value: String(value) },
			)
		}
	}
}

/**
 * Field builder for enum fields with constrained string values.
 * Preserves the literal enum tuple type for inference.
 */
export class EnumFieldBuilder<
	Values extends readonly string[] = readonly string[],
	Req extends boolean = boolean,
	Auto extends boolean = boolean,
> extends FieldBuilder<'enum', Req, Auto, Values[number]> {
	private readonly _enumValues: Values
	private readonly _transitions: TransitionMap | null

	constructor(
		values: Values,
		required = true,
		defaultValue: unknown = undefined,
		auto = false,
		mergeStrategy: FieldMergeStrategy | null = null,
		transitions: TransitionMap | null = null,
	) {
		super('enum', required, defaultValue, auto, mergeStrategy)
		this._enumValues = values
		this._transitions = transitions
	}

	override optional(): EnumFieldBuilder<Values, false, Auto> {
		return new EnumFieldBuilder(
			this._enumValues,
			false,
			this._defaultValue,
			this._auto,
			this._mergeStrategy,
			this._transitions,
		)
	}

	override default(value: Values[number]): EnumFieldBuilder<Values, false, Auto> {
		return new EnumFieldBuilder(
			this._enumValues,
			false,
			value,
			this._auto,
			this._mergeStrategy,
			this._transitions,
		)
	}

	override auto(): EnumFieldBuilder<Values, false, true> {
		return new EnumFieldBuilder(
			this._enumValues,
			false,
			undefined,
			true,
			this._mergeStrategy,
			this._transitions,
		)
	}

	override merge(strategy: FieldMergeStrategy): EnumFieldBuilder<Values, Req, Auto> {
		return new EnumFieldBuilder(
			this._enumValues,
			this._required,
			this._defaultValue,
			this._auto,
			strategy,
			this._transitions,
		)
	}

	/**
	 * Declare allowed state transitions for this enum field.
	 * Enables state machine validation during mutations and merges.
	 *
	 * @param map - Map of state to allowed next states
	 *
	 * @example
	 * ```typescript
	 * t.enum(['draft', 'pending', 'confirmed', 'cancelled']).transitions({
	 *   draft: ['pending', 'cancelled'],
	 *   pending: ['confirmed', 'cancelled'],
	 *   confirmed: [],
	 *   cancelled: [],
	 * })
	 * ```
	 */
	transitions(
		map: Partial<Record<Values[number], Values[number][]>>,
	): EnumFieldBuilder<Values, Req, Auto> {
		// Validate that all source and target states are valid enum values
		const validValues = new Set(this._enumValues as readonly string[])
		for (const [state, targets] of Object.entries(map)) {
			if (!validValues.has(state)) {
				throw new SchemaValidationError(
					`Invalid source state "${state}" in transition map. Valid values: ${[...validValues].join(', ')}`,
					{ state, validValues: [...validValues] },
				)
			}
			for (const target of targets as string[]) {
				if (!validValues.has(target)) {
					throw new SchemaValidationError(
						`Invalid target state "${target}" in transition from "${state}". Valid values: ${[...validValues].join(', ')}`,
						{ state, target, validValues: [...validValues] },
					)
				}
			}
		}
		return new EnumFieldBuilder(
			this._enumValues,
			this._required,
			this._defaultValue,
			this._auto,
			this._mergeStrategy,
			map as TransitionMap,
		)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'enum',
			required: this._required,
			defaultValue: this._defaultValue,
			auto: this._auto,
			enumValues: this._enumValues,
			itemKind: null,
			mergeStrategy: this._mergeStrategy,
			transitions: this._transitions,
		}
	}
}

/** The read type of the values a field builder holds (before nullability). */
export type FieldOutput<F> = F extends { readonly '~field': { readonly output: infer O } }
	? O
	: unknown

/** The write type a field builder accepts (before optionality). */
export type FieldInput<F> = F extends { readonly '~field': { readonly input: infer I } }
	? I
	: unknown

/**
 * Field builder for array fields. Carries the item builder's type, so
 * `t.array(t.enum(['a', 'b']))` infers `('a' | 'b')[]`.
 */
export class ArrayFieldBuilder<
	Item extends FieldBuilder = FieldBuilder,
	Req extends boolean = boolean,
	Auto extends boolean = boolean,
> extends FieldBuilder<'array', Req, Auto, FieldOutput<Item>[], FieldInput<Item>[]> {
	private readonly _item: Item

	constructor(
		itemBuilder: Item,
		required = true,
		defaultValue: unknown = undefined,
		auto = false,
		mergeStrategy: FieldMergeStrategy | null = null,
	) {
		super('array', required, defaultValue, auto, mergeStrategy)
		this._item = itemBuilder
	}

	override optional(): ArrayFieldBuilder<Item, false, Auto> {
		return new ArrayFieldBuilder(
			this._item,
			false,
			this._defaultValue,
			this._auto,
			this._mergeStrategy,
		)
	}

	override default(value: FieldInput<Item>[]): ArrayFieldBuilder<Item, false, Auto> {
		return new ArrayFieldBuilder(this._item, false, value, this._auto, this._mergeStrategy)
	}

	override auto(): ArrayFieldBuilder<Item, false, true> {
		return new ArrayFieldBuilder(this._item, false, undefined, true, this._mergeStrategy)
	}

	override merge(strategy: FieldMergeStrategy): ArrayFieldBuilder<Item, Req, Auto> {
		return new ArrayFieldBuilder(
			this._item,
			this._required,
			this._defaultValue,
			this._auto,
			strategy,
		)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'array',
			required: this._required,
			defaultValue: this._defaultValue,
			auto: this._auto,
			enumValues: null,
			itemKind: this._item._build().kind,
			mergeStrategy: this._mergeStrategy,
			transitions: null,
		}
	}
}

/** Flattens an intersection of object types into one object type (for readable hovers). */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}

type RequiredNestedKeys<F> = {
	[K in keyof F]: F[K] extends { readonly '~field': { readonly required: true } } ? K : never
}[keyof F]

/**
 * The value type of a `t.object({...})` field built from its nested builders. A required
 * nested key is required; an optional or defaulted nested key may be absent or `null`.
 */
export type ObjectFieldValue<
	F extends Record<string, FieldBuilder>,
	Mode extends 'output' | 'input',
> = Simplify<
	{
		[K in RequiredNestedKeys<F>]: Mode extends 'output' ? FieldOutput<F[K]> : FieldInput<F[K]>
	} & {
		[K in Exclude<keyof F, RequiredNestedKeys<F>>]?:
			| (Mode extends 'output' ? FieldOutput<F[K]> : FieldInput<F[K]>)
			| null
	}
>

/**
 * Field builder for structured object fields with a nested field schema. Carries the
 * nested builders' types, so `t.object({ theme: t.string() })` infers `{ theme: string }`.
 *
 * Each nested key merges by its own declared kind (scalars via LWW, nested
 * arrays via add-wins, nested objects recursively), so two devices editing
 * different keys of the same object offline both converge on reconnect instead
 * of one clobbering the other.
 */
export class ObjectFieldBuilder<
	Fields extends Record<string, FieldBuilder> = Record<string, FieldBuilder>,
	Req extends boolean = boolean,
	Auto extends boolean = boolean,
> extends FieldBuilder<
	'object',
	Req,
	Auto,
	ObjectFieldValue<Fields, 'output'>,
	ObjectFieldValue<Fields, 'input'>
> {
	private readonly _fields: Fields

	constructor(
		fields: Fields,
		required = true,
		defaultValue: unknown = undefined,
		auto = false,
		mergeStrategy: FieldMergeStrategy | null = null,
	) {
		super('object', required, defaultValue, auto, mergeStrategy)
		this._fields = fields
	}

	override optional(): ObjectFieldBuilder<Fields, false, Auto> {
		return new ObjectFieldBuilder(
			this._fields,
			false,
			this._defaultValue,
			this._auto,
			this._mergeStrategy,
		)
	}

	override default(
		value: ObjectFieldValue<Fields, 'input'>,
	): ObjectFieldBuilder<Fields, false, Auto> {
		return new ObjectFieldBuilder(this._fields, false, value, this._auto, this._mergeStrategy)
	}

	override auto(): ObjectFieldBuilder<Fields, false, true> {
		return new ObjectFieldBuilder(this._fields, false, undefined, true, this._mergeStrategy)
	}

	override merge(strategy: FieldMergeStrategy): ObjectFieldBuilder<Fields, Req, Auto> {
		return new ObjectFieldBuilder(
			this._fields,
			this._required,
			this._defaultValue,
			this._auto,
			strategy,
		)
	}

	override _build(): FieldDescriptor {
		const nestedFields: Record<string, FieldDescriptor> = {}
		for (const [key, builder] of Object.entries(this._fields)) {
			nestedFields[key] = builder._build()
		}
		return {
			kind: 'object',
			required: this._required,
			defaultValue: this._defaultValue,
			auto: this._auto,
			enumValues: null,
			itemKind: null,
			mergeStrategy: this._mergeStrategy,
			transitions: null,
			nestedFields,
		}
	}
}

/**
 * Field builder for dynamic-key JSON values. Carries a compile-time shape `T`
 * for inference while merging structurally as a convergent CRDT: a plain-object
 * value recurses as a map, an array merges add-wins, any other value is a scalar
 * leaf under last-write-wins.
 *
 * A `Date` nested inside a json value is stored as its ISO string (the canonical
 * operation form), so declare such members as `string` in `T`.
 */
export class JsonFieldBuilder<
	T = unknown,
	Req extends boolean = boolean,
	Auto extends boolean = boolean,
> extends FieldBuilder<'json', Req, Auto, T> {
	override optional(): JsonFieldBuilder<T, false, Auto> {
		return new JsonFieldBuilder<T, false, Auto>(
			'json',
			false,
			this._defaultValue,
			this._auto,
			this._mergeStrategy,
		)
	}

	override default(value: T): JsonFieldBuilder<T, false, Auto> {
		return new JsonFieldBuilder<T, false, Auto>(
			'json',
			false,
			value,
			this._auto,
			this._mergeStrategy,
		)
	}

	override auto(): JsonFieldBuilder<T, false, true> {
		return new JsonFieldBuilder<T, false, true>('json', false, undefined, true, this._mergeStrategy)
	}

	override merge(strategy: FieldMergeStrategy): JsonFieldBuilder<T, Req, Auto> {
		return new JsonFieldBuilder<T, Req, Auto>(
			'json',
			this._required,
			this._defaultValue,
			this._auto,
			strategy,
		)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'json',
			required: this._required,
			defaultValue: this._defaultValue,
			auto: this._auto,
			enumValues: null,
			itemKind: null,
			mergeStrategy: this._mergeStrategy,
			transitions: null,
			nestedFields: null,
		}
	}
}

/**
 * Field builder for secret fields (passwords, tokens, API keys).
 *
 * A secret field's value is never exposed in merge traces, DevTools, or logs
 * (it is redacted at the point traces are built). Its at-rest protection is
 * chosen with `.hashed()` (one-way, for passwords) or `.encrypted()` (reversible,
 * for tokens); the default is `encrypted`.
 */
export class SecretFieldBuilder<
	Req extends boolean = boolean,
	Auto extends boolean = boolean,
> extends FieldBuilder<'secret', Req, Auto, string> {
	private readonly _secretMode: SecretMode

	constructor(
		secretMode: SecretMode = 'encrypted',
		required = true,
		defaultValue: unknown = undefined,
		auto = false,
		mergeStrategy: FieldMergeStrategy | null = null,
	) {
		super('secret', required, defaultValue, auto, mergeStrategy)
		this._secretMode = secretMode
	}

	/** Store this secret as a one-way salted hash (passwords: verify, never read back). */
	hashed(): SecretFieldBuilder<Req, Auto> {
		return new SecretFieldBuilder(
			'hashed',
			this._required,
			this._defaultValue,
			this._auto,
			this._mergeStrategy,
		)
	}

	/** Store this secret as reversible ciphertext (tokens/keys: decrypt to use). */
	encrypted(): SecretFieldBuilder<Req, Auto> {
		return new SecretFieldBuilder(
			'encrypted',
			this._required,
			this._defaultValue,
			this._auto,
			this._mergeStrategy,
		)
	}

	override optional(): SecretFieldBuilder<false, Auto> {
		return new SecretFieldBuilder(
			this._secretMode,
			false,
			this._defaultValue,
			this._auto,
			this._mergeStrategy,
		)
	}

	override default(value: string): SecretFieldBuilder<false, Auto> {
		return new SecretFieldBuilder(this._secretMode, false, value, this._auto, this._mergeStrategy)
	}

	override auto(): SecretFieldBuilder<false, true> {
		return new SecretFieldBuilder(this._secretMode, false, undefined, true, this._mergeStrategy)
	}

	override merge(strategy: FieldMergeStrategy): SecretFieldBuilder<Req, Auto> {
		return new SecretFieldBuilder(
			this._secretMode,
			this._required,
			this._defaultValue,
			this._auto,
			strategy,
		)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'secret',
			required: this._required,
			defaultValue: this._defaultValue,
			auto: this._auto,
			enumValues: null,
			itemKind: null,
			mergeStrategy: this._mergeStrategy,
			transitions: null,
			secretMode: this._secretMode,
		}
	}
}

/** The builder `t.<kind>()` returns for a scalar kind: required, not auto. */
export type ScalarFieldBuilder<K extends ScalarFieldKind> = FieldBuilder<
	K,
	true,
	false,
	ScalarKindToType[K],
	ScalarKindToInput[K]
>

function scalar<K extends ScalarFieldKind>(kind: K): ScalarFieldBuilder<K> {
	return new FieldBuilder(kind, true, undefined, false)
}

/**
 * Type builder namespace. The developer's primary interface for defining field types.
 *
 * Value types: `string` and `secret` are strings, `number` is a finite number,
 * `timestamp` is integer milliseconds since the epoch (`Date` is not accepted; pass
 * `date.getTime()`), `richtext` reads as Yjs update bytes and accepts a string or bytes,
 * `blob` is a `BlobRef`.
 *
 * @example
 * ```typescript
 * import { t } from '@korajs/core'
 *
 * const fields = {
 *   title: t.string(),
 *   count: t.number(),
 *   active: t.boolean().default(true),
 *   notes: t.richtext(),
 *   tags: t.array(t.string()).default([]),
 *   priority: t.enum(['low', 'medium', 'high']).default('medium'),
 *   settings: t.object({ theme: t.string(), fontSize: t.number() }),
 *   metadata: t.json<{ source: string }>(),
 *   createdAt: t.timestamp().auto(),
 * }
 * ```
 */
export const t = {
	/** A string field. */
	string(): ScalarFieldBuilder<'string'> {
		return scalar('string')
	},

	/** A finite-number field. */
	number(): ScalarFieldBuilder<'number'> {
		return scalar('number')
	},

	/** A boolean field. */
	boolean(): ScalarFieldBuilder<'boolean'> {
		return scalar('boolean')
	},

	/** A timestamp field: integer milliseconds since the epoch (not a `Date`). */
	timestamp(): ScalarFieldBuilder<'timestamp'> {
		return scalar('timestamp')
	},

	/** A collaborative rich-text field (Yjs). Reads return the Yjs update bytes. */
	richtext(): ScalarFieldBuilder<'richtext'> {
		return scalar('richtext')
	},

	/** An enum field whose value is one of `values`. */
	enum<const V extends readonly string[]>(values: V): EnumFieldBuilder<V, true, false> {
		assertStorableEnumValues(values)
		return new EnumFieldBuilder(values, true, undefined, false)
	},

	/** An array field whose items have the type of `itemBuilder`. */
	array<Item extends FieldBuilder>(itemBuilder: Item): ArrayFieldBuilder<Item, true, false> {
		return new ArrayFieldBuilder(itemBuilder, true, undefined, false)
	},

	/** A structured object field whose keys are declared by nested builders. */
	object<const F extends Record<string, FieldBuilder>>(
		fields: F,
	): ObjectFieldBuilder<F, true, false> {
		return new ObjectFieldBuilder(fields, true, undefined, false)
	},

	/** A dynamic JSON field typed as `T` (compile-time only; not validated against `T`). */
	json<T = unknown>(): JsonFieldBuilder<T, true, false> {
		return new JsonFieldBuilder<T, true, false>('json', true, undefined, false)
	},

	/** A blob reference field (`BlobRef`); the bytes live in the blob store. */
	blob(): ScalarFieldBuilder<'blob'> {
		return scalar('blob')
	},

	/** A secret field (password, token): redacted from traces, hashed or encrypted at rest. */
	secret(): SecretFieldBuilder<true, false> {
		return new SecretFieldBuilder('encrypted', true, undefined, false)
	},
}
