// lib/domain/uuid.ts
//
// Branded UUID type. Prevents accidental mixing of entity UUIDs with
// ordinary strings. Runtime representation is plain string.

import { z } from "zod";

/**
 * Zod schema that accepts any non-empty string and types it as `Uuid`.
 *
 * The brand is compile-time only, so keep the runtime schema structural.
 * A `.transform(...)` would return the same string at runtime but makes any
 * containing schema impossible to lower through `z.toJSONSchema` — including
 * the shared Predicate / ValueExpression definitions used by SA tools.
 */
export const uuidSchema = z.string().min(1).brand<"Uuid">();
export type Uuid = z.infer<typeof uuidSchema>;

/** Narrowing cast from string → Uuid. Prefer over `as Uuid`. */
export function asUuid(s: string): Uuid {
	return s as Uuid;
}
