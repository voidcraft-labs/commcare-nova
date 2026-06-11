/**
 * Shared accessor for reading string-valued properties off a domain
 * `Field` without branching on its `kind`.
 *
 * `Field` is a discriminated union where each variant declares a
 * different subset of the optional string properties (`relevant`,
 * `validate`, `calculate`, `default_value`, `required`, `hint`, `label`,
 * `case_property_on`, `validate_msg`). Consumers that walk a doc and read
 * these values generically — the XForm emitter, formActions, case-config
 * derivation — can't narrow once per kind without cascading N×M
 * branching.
 *
 * Two key families, split by what the key names:
 *
 *   - Expression slots (the registry's xpath + prose surfaces —
 *     `relevant`, `calculate`, `label`, …, including the nested
 *     `ids_query`) delegate to the domain layer's `expressionSource`
 *     accessor, so the emitters read expression text through the same
 *     single read edge every other consumer uses and a representation
 *     change lands here for free.
 *   - Everything else (`case_property_on` — a case-type ref, not an
 *     expression) stays a plain untyped property lookup; the Zod
 *     schemas guarantee any value present under a known string key is
 *     itself a `string`.
 */

import type { Field, XPathPrintableDoc } from "@/lib/domain";
import { expressionSource, isScalarFieldExpressionSlotId } from "@/lib/domain";

/**
 * Read the string slot `key` names off `field` as `string | undefined`.
 * Expression-slot ids resolve through `expressionSource` (which also
 * handles the nested `ids_query` path, and prints AST-stored slots
 * against `doc` so identity references read as current names); other
 * keys read the property directly. Non-string values (and keys the
 * field's variant doesn't declare) surface as `undefined`.
 */
export function readFieldString(
	field: Field,
	key: string,
	doc: XPathPrintableDoc,
): string | undefined {
	if (isScalarFieldExpressionSlotId(key)) {
		return expressionSource(field, key, doc);
	}
	const value = (field as unknown as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
