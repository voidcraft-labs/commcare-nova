// lib/doc/expressionText.ts
//
// The doc-aware text ⇄ AST bridge for human builder editors. SA/MCP tools
// receive the canonical AST directly and never call this parser. The operator
// repair helper also uses this boundary on its private clone; the
// canonical-identity-foundation migration owns a frozen parser copy instead.
//
// Parsing is total as a projection: a reference-shaped span that does not
// resolve remains text, and a syntax-broken source stays one opaque text run.
// The machine-authoring gate rejects hidden/reference-looking text and syntax
// findings before commit; no unresolved reference enters the stored leaf
// vocabulary.

import { parseXPathExpression } from "@/lib/commcare/xpath";
import { userPropertySlugVerdict } from "@/lib/doc/identifierVerdicts";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import {
	fieldPathResolver,
	printXPath,
	type ResolveUserPropertySlug,
	searchInputNameResolver,
	userPropertySlugResolver,
	type XPathExpression,
	type XPathPrintableDoc,
	xpathPrintContext,
} from "@/lib/domain";

const NO_CLAIMED_USER_PROPERTY_SLUGS: ReadonlySet<string> = new Set();

/**
 * Resolve only one exact, case-insensitively unambiguous, CommCare-valid
 * custom worker-property slug. Everything else remains the final
 * external-name `user-ref` arm.
 */
export function resolvableUserPropertySlug(
	doc: Pick<XPathPrintableDoc, "userProperties">,
): ResolveUserPropertySlug {
	return userPropertySlugResolver(
		doc,
		(slug) => userPropertySlugVerdict(slug, NO_CLAIMED_USER_PROPERTY_SLUGS).ok,
	);
}

/**
 * Parse expression text authored for `fieldUuid`'s slot, resolving
 * form-local references against the field's containing form. A field
 * not reachable from any form resolves nothing — its reference-shaped spans
 * remain text and the commit gate rejects them.
 */
export function parseXPathForField(
	doc: BlueprintDoc,
	fieldUuid: Uuid,
	text: string,
): XPathExpression {
	const formUuid = findContainingForm(doc, fieldUuid);
	return parseXPathExpression(
		text,
		fieldPathResolver(doc, formUuid),
		resolvableUserPropertySlug(doc),
		searchInputNameResolver(doc, formUuid),
	);
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
	return parseXPathExpression(
		text,
		fieldPathResolver(doc, formUuid),
		resolvableUserPropertySlug(doc),
		searchInputNameResolver(doc, formUuid),
	);
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
 * Resolve a builder-authored close-condition field reference (a bare leaf id)
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
		// Membership-array order: the pre-order first match must agree with the
		// wire emitter's `findField`, so a close-field ref resolves to the same
		// UUID at commit time and at emit time even when cousins share an id.
		const ordered = [...(doc.fieldOrder[parentUuid] ?? [])];
		for (const uuid of ordered) {
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
