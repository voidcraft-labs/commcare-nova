/**
 * Shared accessor for reading string-valued properties off a domain
 * `Field` without branching on its `kind`.
 *
 * `Field` is a discriminated union where each variant declares a different
 * subset of expression slots. Consumers that walk a doc and read these values
 * generically — the XForm emitter and form-actions metadata — cannot narrow
 * once per kind without cascading N×M branching.
 *
 * Only the registry's scalar XPath/prose surfaces are accepted. Every value
 * delegates to `expressionSource`, so wire emitters project typed AST storage
 * through one strict read edge. Non-expression field data has its own typed
 * accessors and cannot pass through this function.
 */

import type {
	Field,
	ScalarFieldExpressionSlotId,
	XPathPrintableDoc,
} from "@/lib/domain";
import { expressionSource } from "@/lib/domain";

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
	key: ScalarFieldExpressionSlotId,
	doc: XPathPrintableDoc,
): string | undefined {
	return expressionSource(field, key, doc);
}
