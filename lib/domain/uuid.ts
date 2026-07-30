// lib/domain/uuid.ts
//
// Branded UUID type. Prevents accidental mixing of entity UUIDs with
// ordinary strings. Runtime representation is plain string.

import { z } from "zod";

/**
 * One canonical Nova-authored UUID spelling.
 *
 * The regex deliberately does more than `z.uuid()`:
 *
 * - lowercase only (inputs are rejected, never normalized);
 * - versions 1–8;
 * - the RFC variant (`8`, `9`, `a`, or `b`);
 * - nil and max are impossible because their version/variant nibbles fail.
 *
 * Keeping this as a string regex means `z.toJSONSchema()` emits the complete
 * admission rule as `pattern`; a custom refinement would disappear from the
 * generated SA/MCP schema.
 */
export const CANONICAL_UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const uuidSchema = z
	.string()
	.regex(CANONICAL_UUID_PATTERN, "Expected a canonical lowercase RFC UUID.")
	.brand<"Uuid">();
export type Uuid = z.infer<typeof uuidSchema>;

/** Parse and narrow string → Uuid. Prefer over unchecked type assertions. */
export function asUuid(s: string): Uuid {
	return uuidSchema.parse(s);
}
