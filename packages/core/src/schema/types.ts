import type { FieldDescriptor, FieldKind } from '../types'

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

	constructor(kind: Kind, required = true as unknown as Req, defaultValue: unknown = undefined, auto = false as unknown as Auto) {
		this._kind = kind
		this._required = required as unknown as boolean
		this._defaultValue = defaultValue
		this._auto = auto as unknown as boolean
	}

	/** Mark this field as optional (not required on insert) */
	optional(): FieldBuilder<Kind, false, Auto> {
		return new FieldBuilder(this._kind, false, this._defaultValue, this._auto)
	}

	/** Set a default value for this field. Implicitly makes the field optional. */
	default(value: unknown): FieldBuilder<Kind, false, Auto> {
		return new FieldBuilder(this._kind, false, value, this._auto)
	}

	/** Mark this field as auto-populated (e.g., createdAt timestamps). Developers cannot set auto fields. */
	auto(): FieldBuilder<Kind, false, true> {
		return new FieldBuilder(this._kind, false, undefined, true)
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

	constructor(
		values: Values,
		required = true as unknown as Req,
		defaultValue: unknown = undefined,
		auto = false as unknown as Auto,
	) {
		super('enum', required, defaultValue, auto)
		this._enumValues = values
	}

	override optional(): EnumFieldBuilder<Values, false, Auto> {
		return new EnumFieldBuilder(this._enumValues, false, this._defaultValue, this._auto)
	}

	override default(value: Values[number]): EnumFieldBuilder<Values, false, Auto> {
		return new EnumFieldBuilder(this._enumValues, false, value, this._auto)
	}

	override auto(): EnumFieldBuilder<Values, false, true> {
		return new EnumFieldBuilder(this._enumValues, false, undefined, true)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'enum',
			required: this._required as unknown as boolean,
			defaultValue: this._defaultValue,
			auto: this._auto as unknown as boolean,
			enumValues: this._enumValues,
			itemKind: null,
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
	) {
		super('array', required, defaultValue, auto)
		this._itemKind = itemBuilder._build().kind as ItemKind
	}

	override optional(): ArrayFieldBuilder<ItemKind, false, Auto> {
		return new ArrayFieldBuilder(
			new FieldBuilder(this._itemKind),
			false,
			this._defaultValue,
			this._auto,
		)
	}

	override default(value: unknown[]): ArrayFieldBuilder<ItemKind, false, Auto> {
		return new ArrayFieldBuilder(new FieldBuilder(this._itemKind), false, value, this._auto)
	}

	override auto(): ArrayFieldBuilder<ItemKind, false, true> {
		return new ArrayFieldBuilder(new FieldBuilder(this._itemKind), false, undefined, true)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'array',
			required: this._required as unknown as boolean,
			defaultValue: this._defaultValue,
			auto: this._auto as unknown as boolean,
			enumValues: null,
			itemKind: this._itemKind,
		}
	}
}

/**
 * Type builder namespace. The developer's primary interface for defining field types.
 *
 * @example
 * ```typescript
 * import { t } from '@kora/core'
 *
 * const fields = {
 *   title: t.string(),
 *   count: t.number(),
 *   active: t.boolean().default(true),
 *   notes: t.richtext(),
 *   tags: t.array(t.string()).default([]),
 *   priority: t.enum(['low', 'medium', 'high']).default('medium'),
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
}
