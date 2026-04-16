// lib/domain/uuid.ts
//
// Branded UUID type. Prevents accidental mixing of entity UUIDs with
// ordinary strings. Runtime representation is plain string.

import { z } from "zod";

export type Uuid = string & { readonly __brand: "Uuid" };

/** Narrowing cast from string → Uuid. Prefer over `as Uuid`. */
export function asUuid(s: string): Uuid {
	return s as Uuid;
}

/** Zod schema that accepts any string and types it as `Uuid`. */
export const uuidSchema = z
	.string()
	.min(1)
	.transform((s) => s as Uuid);
