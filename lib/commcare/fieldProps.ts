/**
 * Shared accessor for reading string-valued properties off a domain
 * `Field` without branching on its `kind`.
 *
 * `Field` is a discriminated union where each variant declares a different
 * subset of expression slots. Consumers that walk a doc and read these values
 * generically — the XForm emitter and form-actions metadata — cannot narrow
 * once per kind without cascading N×M branching.
 *
 * Only the registry's scalar XPath/prose surfaces are accepted. XPath values
 * use the wire source projection; prose uses the domain projection.
 * Non-expression field data has its own typed accessors.
 */

import type {
	Field,
	ScalarFieldExpressionSlotId,
	XPathPrintableDoc,
} from "@/lib/domain";
import { expressionSource, fieldExpressionValue } from "@/lib/domain";
import { printWireXPathSource } from "./xpath/wireSource";

/**
 * Read the string slot `key` names off `field` as `string | undefined`.
 * The registry resolves nested slots such as `ids_query`. Both XPath
 * reference spellings use current field names and the form's wire-path map.
 * Slots the field's variant does not declare return `undefined`.
 */
export function readFieldString(
	field: Field,
	key: ScalarFieldExpressionSlotId,
	doc: XPathPrintableDoc,
): string | undefined {
	const expression = fieldExpressionValue(field, key);
	return expression === undefined
		? expressionSource(field, key, doc)
		: printWireXPathSource(expression, doc);
}
