import type { FieldDescriptor, FieldKind } from '../types'

/**
 * Base field builder implementing the builder pattern for schema field definitions.
 * Each builder is immutable — modifier methods return new builder instances.
 *
 * @example
 * ```typescript
 * t.string()                    // required string field
 * t.string().optional()         // optional string field
 * t.string().default('hello')   // string with default value
 * t.timestamp().auto()          // auto-populated timestamp
 * ```
 */
export class FieldBuilder<Kind extends FieldKind = FieldKind> {
	protected readonly _kind: Kind
	protected readonly _required: boolean
	protected readonly _defaultValue: unknown
	protected readonly _auto: boolean

	constructor(kind: Kind, required = true, defaultValue: unknown = undefined, auto = false) {
		this._kind = kind
		this._required = required
		this._defaultValue = defaultValue
		this._auto = auto
	}

	/** Mark this field as optional (not required on insert) */
	optional(): FieldBuilder<Kind> {
		return new FieldBuilder(this._kind, false, this._defaultValue, this._auto)
	}

	/** Set a default value for this field. Implicitly makes the field optional. */
	default(value: unknown): FieldBuilder<Kind> {
		return new FieldBuilder(this._kind, false, value, this._auto)
	}

	/** Mark this field as auto-populated (e.g., createdAt timestamps). Developers cannot set auto fields. */
	auto(): FieldBuilder<Kind> {
		return new FieldBuilder(this._kind, false, undefined, true)
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
		}
	}
}

/**
 * Field builder for enum fields with constrained string values.
 */
export class EnumFieldBuilder extends FieldBuilder<'enum'> {
	private readonly _enumValues: readonly string[]

	constructor(
		values: readonly string[],
		required = true,
		defaultValue: unknown = undefined,
		auto = false,
	) {
		super('enum', required, defaultValue, auto)
		this._enumValues = values
	}

	override optional(): EnumFieldBuilder {
		return new EnumFieldBuilder(this._enumValues, false, this._defaultValue, this._auto)
	}

	override default(value: string): EnumFieldBuilder {
		return new EnumFieldBuilder(this._enumValues, false, value, this._auto)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'enum',
			required: this._required,
			defaultValue: this._defaultValue,
			auto: this._auto,
			enumValues: this._enumValues,
			itemKind: null,
		}
	}
}

/**
 * Field builder for array fields with a typed item kind.
 */
export class ArrayFieldBuilder extends FieldBuilder<'array'> {
	private readonly _itemKind: FieldKind

	constructor(
		itemBuilder: FieldBuilder,
		required = true,
		defaultValue: unknown = undefined,
		auto = false,
	) {
		super('array', required, defaultValue, auto)
		this._itemKind = itemBuilder._build().kind
	}

	override optional(): ArrayFieldBuilder {
		const builder = new ArrayFieldBuilder(
			new FieldBuilder(this._itemKind),
			false,
			this._defaultValue,
			this._auto,
		)
		return builder
	}

	override default(value: unknown[]): ArrayFieldBuilder {
		return new ArrayFieldBuilder(new FieldBuilder(this._itemKind), false, value, this._auto)
	}

	override _build(): FieldDescriptor {
		return {
			kind: 'array',
			required: this._required,
			defaultValue: this._defaultValue,
			auto: this._auto,
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
	string(): FieldBuilder<'string'> {
		return new FieldBuilder('string')
	},

	number(): FieldBuilder<'number'> {
		return new FieldBuilder('number')
	},

	boolean(): FieldBuilder<'boolean'> {
		return new FieldBuilder('boolean')
	},

	timestamp(): FieldBuilder<'timestamp'> {
		return new FieldBuilder('timestamp')
	},

	richtext(): FieldBuilder<'richtext'> {
		return new FieldBuilder('richtext')
	},

	enum<const T extends readonly string[]>(values: T): EnumFieldBuilder {
		return new EnumFieldBuilder(values)
	},

	array(itemBuilder: FieldBuilder): ArrayFieldBuilder {
		return new ArrayFieldBuilder(itemBuilder)
	},
}
