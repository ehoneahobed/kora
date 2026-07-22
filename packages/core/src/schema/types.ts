import { SchemaValidationError } from '../errors/errors'
import type {
	FieldDescriptor,
	FieldKind,
	FieldMergeStrategy,
	SecretMode,
	TransitionMap,
} from '../types'

/**
 * Base field builder implementing the builder pattern for schema field definitions.
 * Each builder is immutable — modifier methods return new builder instances.
 *
 * Type parameters track field metadata at the type level for inference:
 * - Kind: the field kind ('string', 'number', etc.)
 * - Req: whether the field is required (true = required on insert)
 * - Auto: whether the field is auto-populated (true = excluded from insert input)
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
	Req extends boolean = true,
	Auto extends boolean = false,
> {
	protected readonly _kind: Kind
	protected readonly _required: boolean
	protected readonly _defaultValue: unknown
	protected readonly _auto: boolean
	protected readonly _mergeStrategy: FieldMergeStrategy | null

	constructor(
		kind: Kind,
		required = true as unknown as Req,
		defaultValue: unknown = undefined,
		auto = false as unknown as Auto,
		mergeStrategy: FieldMergeStrategy | null = null,
	) {
		this._kind = kind
		this._required = required as unknown as boolean
		this._defaultValue = defaultValue
		this._auto = auto as unknown as boolean
		this._mergeStrategy = mergeStrategy
	}

	/** Mark this field as optional (not required on insert) */
	optional(): FieldBuilder<Kind, false, Auto> {
		return new FieldBuilder(this._kind, false, this._defaultValue, this._auto, this._mergeStrategy)
	}

	/** Set a default value for this field. Implicitly makes the field optional. */
	default(value: unknown): FieldBuilder<Kind, false, Auto> {
		return new FieldBuilder(this._kind, false, value, this._auto, this._mergeStrategy)
	}

	/** Mark this field as auto-populated (e.g., createdAt timestamps). Developers cannot set auto fields. */
	auto(): FieldBuilder<Kind, false, true> {
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
	merge(strategy: FieldMergeStrategy): FieldBuilder<Kind, Req, Auto> {
		return new FieldBuilder(
			this._kind,
			this._required as unknown as Req,
			this._defaultValue,
			this._auto as unknown as Auto,
			strategy,
		)
	}

	/** @internal Build the final FieldDescriptor. Used by defineSchema(). */
	_build(): FieldDescriptor {
		return {
			kind: this._kind,
			required: this._required as unknown as boolean,
			defaultValue: this._defaultValue,
			auto: this._auto as unknown as boolean,
			enumValues: null,
			itemKind: null,
			mergeStrategy: this._mergeStrategy,
			transitions: null,
		}
	}
}

/**
 * Field builder for enum fields with constrained string values.
 * Preserves the literal enum tuple type for inference.
 */
export class EnumFieldBuilder<
	Values extends readonly string[] = readonly string[],
	Req extends boolean = true,
	Auto extends boolean = false,
> extends FieldBuilder<'enum', Req, Auto> {
	private readonly _enumValues: Values
	private readonly _transitions: TransitionMap | null

	constructor(
		values: Values,
		required = true as unknown as Req,
		defaultValue: unknown = undefined,
		auto = false as unknown as Auto,
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
			this._required as unknown as Req,
			this._defaultValue,
			this._auto as unknown as Auto,
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
			this._required as unknown as Req,
			this._defaultValue,
			this._auto as unknown as Auto,
			this._mergeStrategy,
			map as TransitionMap,
		)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'enum',
			required: this._required as unknown as boolean,
			defaultValue: this._defaultValue,
			auto: this._auto as unknown as boolean,
			enumValues: this._enumValues,
			itemKind: null,
			mergeStrategy: this._mergeStrategy,
			transitions: this._transitions,
		}
	}
}

/**
 * Field builder for array fields with a typed item kind.
 * Preserves the item kind type parameter for inference.
 */
export class ArrayFieldBuilder<
	ItemKind extends FieldKind = FieldKind,
	Req extends boolean = true,
	Auto extends boolean = false,
> extends FieldBuilder<'array', Req, Auto> {
	private readonly _itemKind: ItemKind

	constructor(
		itemBuilder: FieldBuilder<ItemKind>,
		required = true as unknown as Req,
		defaultValue: unknown = undefined,
		auto = false as unknown as Auto,
		mergeStrategy: FieldMergeStrategy | null = null,
	) {
		super('array', required, defaultValue, auto, mergeStrategy)
		this._itemKind = itemBuilder._build().kind as ItemKind
	}

	override optional(): ArrayFieldBuilder<ItemKind, false, Auto> {
		return new ArrayFieldBuilder(
			new FieldBuilder(this._itemKind),
			false,
			this._defaultValue,
			this._auto,
			this._mergeStrategy,
		)
	}

	override default(value: unknown[]): ArrayFieldBuilder<ItemKind, false, Auto> {
		return new ArrayFieldBuilder(
			new FieldBuilder(this._itemKind),
			false,
			value,
			this._auto,
			this._mergeStrategy,
		)
	}

	override auto(): ArrayFieldBuilder<ItemKind, false, true> {
		return new ArrayFieldBuilder(
			new FieldBuilder(this._itemKind),
			false,
			undefined,
			true,
			this._mergeStrategy,
		)
	}

	override merge(strategy: FieldMergeStrategy): ArrayFieldBuilder<ItemKind, Req, Auto> {
		return new ArrayFieldBuilder(
			new FieldBuilder(this._itemKind),
			this._required as unknown as Req,
			this._defaultValue,
			this._auto as unknown as Auto,
			strategy,
		)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'array',
			required: this._required as unknown as boolean,
			defaultValue: this._defaultValue,
			auto: this._auto as unknown as boolean,
			enumValues: null,
			itemKind: this._itemKind,
			mergeStrategy: this._mergeStrategy,
			transitions: null,
		}
	}
}

/**
 * Field builder for structured object fields with a nested field schema.
 *
 * Each nested key merges by its own declared kind (scalars via LWW, nested
 * arrays via add-wins, nested objects recursively), so two devices editing
 * different keys of the same object offline both converge on reconnect instead
 * of one clobbering the other.
 */
export class ObjectFieldBuilder<
	Req extends boolean = true,
	Auto extends boolean = false,
> extends FieldBuilder<'object', Req, Auto> {
	private readonly _fields: Record<string, FieldBuilder>

	constructor(
		fields: Record<string, FieldBuilder>,
		required = true as unknown as Req,
		defaultValue: unknown = undefined,
		auto = false as unknown as Auto,
		mergeStrategy: FieldMergeStrategy | null = null,
	) {
		super('object', required, defaultValue, auto, mergeStrategy)
		this._fields = fields
	}

	override optional(): ObjectFieldBuilder<false, Auto> {
		return new ObjectFieldBuilder(
			this._fields,
			false,
			this._defaultValue,
			this._auto,
			this._mergeStrategy,
		)
	}

	override default(value: Record<string, unknown>): ObjectFieldBuilder<false, Auto> {
		return new ObjectFieldBuilder(this._fields, false, value, this._auto, this._mergeStrategy)
	}

	override auto(): ObjectFieldBuilder<false, true> {
		return new ObjectFieldBuilder(this._fields, false, undefined, true, this._mergeStrategy)
	}

	override merge(strategy: FieldMergeStrategy): ObjectFieldBuilder<Req, Auto> {
		return new ObjectFieldBuilder(
			this._fields,
			this._required as unknown as Req,
			this._defaultValue,
			this._auto as unknown as Auto,
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
			required: this._required as unknown as boolean,
			defaultValue: this._defaultValue,
			auto: this._auto as unknown as boolean,
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
 */
export class JsonFieldBuilder<
	T = unknown,
	Req extends boolean = true,
	Auto extends boolean = false,
> extends FieldBuilder<'json', Req, Auto> {
	override optional(): JsonFieldBuilder<T, false, Auto> {
		return new JsonFieldBuilder<T, false, Auto>(
			'json',
			false,
			this._defaultValue,
			this._auto as unknown as Auto,
			this._mergeStrategy,
		)
	}

	override default(value: T): JsonFieldBuilder<T, false, Auto> {
		return new JsonFieldBuilder<T, false, Auto>(
			'json',
			false,
			value,
			this._auto as unknown as Auto,
			this._mergeStrategy,
		)
	}

	override auto(): JsonFieldBuilder<T, false, true> {
		return new JsonFieldBuilder<T, false, true>('json', false, undefined, true, this._mergeStrategy)
	}

	override merge(strategy: FieldMergeStrategy): JsonFieldBuilder<T, Req, Auto> {
		return new JsonFieldBuilder<T, Req, Auto>(
			'json',
			this._required as unknown as Req,
			this._defaultValue,
			this._auto as unknown as Auto,
			strategy,
		)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'json',
			required: this._required as unknown as boolean,
			defaultValue: this._defaultValue,
			auto: this._auto as unknown as boolean,
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
	Req extends boolean = true,
	Auto extends boolean = false,
> extends FieldBuilder<'secret', Req, Auto> {
	private readonly _secretMode: SecretMode

	constructor(
		secretMode: SecretMode = 'encrypted',
		required = true as unknown as Req,
		defaultValue: unknown = undefined,
		auto = false as unknown as Auto,
		mergeStrategy: FieldMergeStrategy | null = null,
	) {
		super('secret', required, defaultValue, auto, mergeStrategy)
		this._secretMode = secretMode
	}

	/** Store this secret as a one-way salted hash (passwords: verify, never read back). */
	hashed(): SecretFieldBuilder<Req, Auto> {
		return new SecretFieldBuilder(
			'hashed',
			this._required as unknown as Req,
			this._defaultValue,
			this._auto as unknown as Auto,
			this._mergeStrategy,
		)
	}

	/** Store this secret as reversible ciphertext (tokens/keys: decrypt to use). */
	encrypted(): SecretFieldBuilder<Req, Auto> {
		return new SecretFieldBuilder(
			'encrypted',
			this._required as unknown as Req,
			this._defaultValue,
			this._auto as unknown as Auto,
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

	override auto(): SecretFieldBuilder<false, true> {
		return new SecretFieldBuilder(this._secretMode, false, undefined, true, this._mergeStrategy)
	}

	override merge(strategy: FieldMergeStrategy): SecretFieldBuilder<Req, Auto> {
		return new SecretFieldBuilder(
			this._secretMode,
			this._required as unknown as Req,
			this._defaultValue,
			this._auto as unknown as Auto,
			strategy,
		)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'secret',
			required: this._required as unknown as boolean,
			defaultValue: this._defaultValue,
			auto: this._auto as unknown as boolean,
			enumValues: null,
			itemKind: null,
			mergeStrategy: this._mergeStrategy,
			transitions: null,
			secretMode: this._secretMode,
		}
	}
}

/**
 * Type builder namespace. The developer's primary interface for defining field types.
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
	string(): FieldBuilder<'string', true, false> {
		return new FieldBuilder('string', true, undefined, false)
	},

	number(): FieldBuilder<'number', true, false> {
		return new FieldBuilder('number', true, undefined, false)
	},

	boolean(): FieldBuilder<'boolean', true, false> {
		return new FieldBuilder('boolean', true, undefined, false)
	},

	timestamp(): FieldBuilder<'timestamp', true, false> {
		return new FieldBuilder('timestamp', true, undefined, false)
	},

	richtext(): FieldBuilder<'richtext', true, false> {
		return new FieldBuilder('richtext', true, undefined, false)
	},

	enum<const V extends readonly string[]>(values: V): EnumFieldBuilder<V, true, false> {
		return new EnumFieldBuilder(values, true, undefined, false)
	},

	array<K extends FieldKind>(itemBuilder: FieldBuilder<K>): ArrayFieldBuilder<K, true, false> {
		return new ArrayFieldBuilder(itemBuilder, true, undefined, false)
	},

	object(fields: Record<string, FieldBuilder>): ObjectFieldBuilder<true, false> {
		return new ObjectFieldBuilder(fields, true, undefined, false)
	},

	json<T = unknown>(): JsonFieldBuilder<T, true, false> {
		return new JsonFieldBuilder<T, true, false>('json', true, undefined, false)
	},

	blob(): FieldBuilder<'blob', true, false> {
		return new FieldBuilder('blob', true, undefined, false)
	},

	secret(): SecretFieldBuilder<true, false> {
		return new SecretFieldBuilder('encrypted', true, undefined, false)
	},
}
