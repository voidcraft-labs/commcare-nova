// lib/domain/xpath/print.ts
//
// The printer half of the expression round-trip law: project a stored
// `XPathExpression` back to source text, resolving identity leaves to
// their CURRENT spelling. This is the single place a renamed field's
// new name reaches an expression — no rewrite ever touched the stored
// slot; the print just resolves the uuid again.
//
// Printing is TOTAL. An identity leaf whose target no longer resolves
// (unreachable through the gated surfaces — deleting a referenced
// field rejects at commit) prints the raw uuid in the reference's
// spelling (`#form/<uuid>` / `/data/<uuid>`), which the validator
// flags from the printed text. A throw here would take down emit and
// validation for the whole doc over one corrupt leaf.

import { ownRecordValue, recordFromEntries } from "../records";
import type { XPathExpression } from "./ast";

/**
 * Resolution context for printing: identity → current spelling.
 * Build one per pass via `xpathPrintContext(doc)` — it caches per
 * uuid, so a validator scan or an emit walk pays each resolution once.
 */
export interface XPathPrintContext {
	/**
	 * The target field's current id path from its form root
	 * (e.g. `["grp", "age"]`), or `undefined` when the uuid doesn't
	 * resolve to a field reachable from a form.
	 */
	fieldPathSegments(uuid: string): readonly string[] | undefined;
	/** The custom worker-information property's current saved name. */
	userPropertySlug(uuid: string): string | undefined;
}

/**
 * The doc surface printing needs — structural so both `BlueprintDoc`
 * and raw persisted records satisfy it without this module importing
 * the blueprint schema (the field schemas import THIS package; the
 * blueprint imports the field schemas).
 */
export interface XPathPrintableDoc {
	fields: Record<string, { id: string } | undefined>;
	forms: Record<string, unknown>;
	fieldOrder: Record<string, readonly string[] | undefined>;
	userProperties?: Record<string, { slug: string } | undefined>;
	/** The maintained reverse index when present (in-memory docs);
	 *  printing derives its own from `fieldOrder` when absent. */
	fieldParent?: Record<string, string | null | undefined>;
}

/**
 * Build a print context over a doc. Resolution walks the target's
 * ancestor chain to its form root and returns the id segments — the
 * exact inverse of the parse-side `fieldPathResolver`, which is what
 * makes `print(parse(s))` reproduce the original bytes over an
 * unrenamed doc.
 */
export function xpathPrintContext(doc: XPathPrintableDoc): XPathPrintContext {
	let derivedParents: Record<string, string> | undefined;
	const parentOf = (uuid: string): string | undefined => {
		const maintained = ownRecordValue(doc.fieldParent, uuid);
		if (typeof maintained === "string") return maintained;
		if (doc.fieldParent !== undefined && maintained !== undefined) {
			return undefined;
		}
		// Read-only widenings (compile, upload, preview) may carry no
		// fieldParent — derive a reverse map from fieldOrder once.
		if (derivedParents === undefined) {
			derivedParents = recordFromEntries([]);
			for (const [parent, children] of Object.entries(doc.fieldOrder)) {
				for (const child of children ?? []) derivedParents[child] = parent;
			}
		}
		return ownRecordValue(derivedParents, uuid);
	};

	const cache = new Map<string, readonly string[] | undefined>();
	return {
		fieldPathSegments(uuid) {
			const cached = cache.get(uuid);
			if (cached !== undefined || cache.has(uuid)) return cached;
			const segments: string[] = [];
			let result: readonly string[] | undefined;
			let cursor: string | undefined = uuid;
			const seen = new Set<string>();
			while (cursor !== undefined && !seen.has(cursor)) {
				const field = ownRecordValue(doc.fields, cursor);
				if (!field) break;
				seen.add(cursor);
				segments.unshift(field.id);
				const parent = parentOf(cursor);
				if (
					parent !== undefined &&
					ownRecordValue(doc.forms, parent) !== undefined
				) {
					result = segments;
					break;
				}
				cursor = parent;
			}
			cache.set(uuid, result);
			return result;
		},
		userPropertySlug(uuid) {
			return ownRecordValue(doc.userProperties, uuid)?.slug;
		},
	};
}

/**
 * Project an expression to source text. Text runs are verbatim;
 * reference leaves resolve through `ctx`:
 *
 *   - `field-ref` → `#form/<current path>`
 *   - `path-ref`  → canonical absolute `/data/<current path>`
 *   - `user-property-ref` → the target property's current saved name
 *   - `case-ref` / `user-ref` / `raw-ref` → their name spelling
 */
export function printXPath(
	expr: XPathExpression,
	ctx: XPathPrintContext,
): string {
	let out = "";
	for (const part of expr.parts) {
		switch (part.kind) {
			case "text":
				out += part.text;
				break;
			case "field-ref": {
				const segments = ctx.fieldPathSegments(part.uuid) ?? [part.uuid];
				out += `#form/${segments.join("/")}`;
				break;
			}
			case "path-ref": {
				const path = ctx.fieldPathSegments(part.uuid) ?? [part.uuid];
				out += `/data/${path.join("/")}`;
				break;
			}
			case "case-ref":
				out += `#${part.caseType}/${part.property}`;
				break;
			case "user-ref":
				out += `#user/${part.property}`;
				break;
			case "user-property-ref":
				out += `#user/${
					ctx.userPropertySlug(part.userPropertyUuid) ?? part.userPropertyUuid
				}`;
				break;
			case "raw-ref":
				out += `#${part.namespace}/${part.segments.join("/")}`;
				break;
			default: {
				const _exhaustive: never = part;
				break;
			}
		}
	}
	return out;
}
