// lib/doc/expressionText.ts
//
// The doc-aware text ⇄ AST bridge every commit surface shares: builder
// editors, the SA tool layer's field assembly/patching, and the
// one-time migration scripts all turn authored XPath TEXT into the
// stored expression AST through here, so reference resolution (which
// textual shapes become identity leaves) has exactly one definition.
//
// Parsing is TOTAL — a reference that doesn't resolve stays a raw
// leaf and a syntax-broken source stays one opaque text run; the
// commit gate adjudicates the PRINTED text with the same validator
// findings it always used, so there is no parse-failure channel here.

import { parseXPathExpression } from "@/lib/commcare/xpath";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import {
	fieldPathResolver,
	printXPath,
	type XPathExpression,
	xpathPrintContext,
} from "@/lib/domain";

/**
 * Parse expression text authored for `fieldUuid`'s slot, resolving
 * form-local references against the field's containing form. A field
 * not reachable from any form resolves nothing — its references stay
 * raw leaves.
 */
export function parseXPathForField(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	text: string,
): XPathExpression {
	const formUuid = findContainingForm(doc, fieldUuid);
	return parseXPathExpression(text, fieldPathResolver(doc, formUuid));
}

/**
 * Parse expression text scoped to a form (form-level slots, and field
 * slots whose field hasn't landed on the doc yet).
 */
export function parseXPathForForm(
	doc: BlueprintDoc,
	formUuid: Uuid | undefined,
	text: string,
): XPathExpression {
	return parseXPathExpression(text, fieldPathResolver(doc, formUuid));
}

/** Print an expression against a doc — the read-side convenience for
 *  callers without a longer-lived print context. */
export function printXPathInDoc(
	doc: BlueprintDoc,
	expr: XPathExpression,
): string {
	return printXPath(expr, xpathPrintContext(doc));
}

/** The structural slice the close-field resolver needs — both the doc
 *  and the builder UI's `{ fields, fieldOrder }` selector shape. */
export interface FieldRefResolvableDoc {
	fields: Readonly<Record<string, { uuid: Uuid; id: string } | undefined>>;
	fieldOrder: Readonly<Record<string, readonly string[] | undefined>>;
}

/**
 * Resolve an authored close-condition field reference (a bare leaf id)
 * to the target field's stable uuid — pre-order first match across the
 * form's tree, the same rule the wire emitter's `findField` applies —
 * or return the text verbatim when nothing answers to it (a dangling
 * pointer the validator's close-condition rules flag from the slot).
 */
export function resolveCloseFieldRef(
	doc: FieldRefResolvableDoc,
	formUuid: string,
	ref: string,
): Uuid | string {
	if (ref.length === 0) return ref;
	const find = (parentUuid: string): Uuid | undefined => {
		for (const uuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[uuid];
			if (!field) continue;
			if (field.id === ref) return field.uuid;
			if (doc.fieldOrder[uuid] !== undefined) {
				const found = find(uuid);
				if (found !== undefined) return found;
			}
		}
		return undefined;
	};
	return find(formUuid) ?? ref;
}
