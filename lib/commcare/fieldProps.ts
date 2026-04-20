/**
 * Shared accessor for reading string-valued properties off a domain
 * `Field` without branching on its `kind`.
 *
 * `Field` is a discriminated union where each variant declares a
 * different subset of the optional string properties (`relevant`,
 * `validate`, `calculate`, `default_value`, `required`, `hint`, `label`,
 * `case_property`, `validate_msg`). Consumers that walk a doc and read
 * these values generically — the XForm emitter, formActions, case-config
 * derivation — can't narrow once per kind without cascading N×M
 * branching. `readFieldString` reads through the union via a single
 * untyped lookup and returns `undefined` when the key isn't declared on
 * the matched variant; the Zod schemas guarantee that any value present
 * under one of the known string keys is itself a `string`.
 */

import type { Field } from "@/lib/domain";

/**
 * Read `field[key]` as a `string | undefined`. Non-string values (and
 * keys that don't exist on the field's variant) surface as `undefined`.
 */
export function readFieldString(field: Field, key: string): string | undefined {
	const value = (field as unknown as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
