import { z } from "zod";

/**
 * Whether a JavaScript number has one unambiguous JSON representation that
 * Nova can persist and recover without changing identity.
 *
 * Finite non-integers are admitted because `JSON.stringify` supplies their
 * unique shortest round-trip decimal. Integral values must remain inside
 * JavaScript's safe-integer range, and negative zero is forbidden because JSON
 * would silently rewrite it to positive zero.
 */
export function isPersistableJsonNumber(value: number): boolean {
	return (
		Number.isFinite(value) &&
		!Object.is(value, -0) &&
		(!Number.isInteger(value) || Number.isSafeInteger(value))
	);
}

export const PERSISTABLE_JSON_NUMBER_MESSAGE =
	"Number must be finite, must not be negative zero, and integral values must be safe integers.";

const withPersistableJsonNumber = <Schema extends z.ZodNumber>(
	schema: Schema,
): Schema =>
	schema.refine(isPersistableJsonNumber, {
		message: PERSISTABLE_JSON_NUMBER_MESSAGE,
	}) as Schema;

export const persistableJsonNumberSchema = withPersistableJsonNumber(
	z.number(),
);

export const persistableJsonIntegerSchema = withPersistableJsonNumber(
	z.number().int(),
);

export const persistableJsonPositiveNumberSchema = withPersistableJsonNumber(
	z.number().positive(),
);

export const persistableJsonNonnegativeIntegerSchema =
	withPersistableJsonNumber(z.number().int().min(0));

export const persistableJsonPositiveIntegerSchema = withPersistableJsonNumber(
	z.number().int().positive(),
);
