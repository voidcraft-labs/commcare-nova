// lib/domain/xpath/print.ts
//
// The printer half of the expression round-trip law: project a stored
// `XPathExpression` back to source text, resolving identity leaves to
// their CURRENT spelling. This is the single place a renamed field's
// new name reaches an expression — no rewrite ever touched the stored
// slot; the print just resolves the uuid again.
//
// Human projection is total and never leaks stored UUID text: unresolved
// identities produce a structured result plus an explicit repair marker.
// `printXPath` is the strict wire/runtime boundary and throws on that result.

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
	/** The Search prompt's current name, wherever its module is. */
	searchInputName(uuid: string): string | undefined;
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
	/** Modules, for the Search prompts a `search-answer-ref` names. */
	modules?: Record<
		string,
		| {
				caseListConfig?: {
					searchInputs: readonly { uuid: string; name: string }[];
				};
		  }
		| undefined
	>;
	/** The maintained reverse index when present (in-memory docs);
	 *  printing derives its own from `fieldOrder` when absent. */
	fieldParent?: Record<string, string | null | undefined>;
}

export interface UnresolvedXPathProjection {
	readonly kind:
		| "field-ref"
		| "path-ref"
		| "user-property-ref"
		| "search-answer-ref";
	readonly identity: string;
}

export type XPathProjectionResult =
	| { readonly ok: true; readonly text: string }
	| {
			readonly ok: false;
			readonly text: string;
			readonly unresolved: readonly UnresolvedXPathProjection[];
	  };

export class XPathProjectionError extends Error {
	constructor(readonly unresolved: readonly UnresolvedXPathProjection[]) {
		super("XPath contains an unresolved authored reference.");
		this.name = "XPathProjectionError";
	}
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
		searchInputName(uuid) {
			for (const mod of Object.values(doc.modules ?? {})) {
				const input = mod?.caseListConfig?.searchInputs.find(
					(candidate) => candidate.uuid === uuid,
				);
				if (input !== undefined) return input.name;
			}
			return undefined;
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
 *   - `case-ref` / `user-ref` → their name spelling
 */
export function projectXPath(
	expr: XPathExpression,
	ctx: XPathPrintContext,
): XPathProjectionResult {
	let out = "";
	const unresolved: UnresolvedXPathProjection[] = [];
	for (const part of expr.parts) {
		switch (part.kind) {
			case "text":
				out += part.text;
				break;
			case "field-ref": {
				const segments = ctx.fieldPathSegments(part.uuid);
				if (segments === undefined) {
					unresolved.push({ kind: part.kind, identity: part.uuid });
					out += "#form/[reference needs repair]";
				} else {
					out += `#form/${segments.join("/")}`;
				}
				break;
			}
			case "path-ref": {
				const path = ctx.fieldPathSegments(part.uuid);
				if (path === undefined) {
					unresolved.push({ kind: part.kind, identity: part.uuid });
					out += "/data/[reference needs repair]";
				} else {
					out += `/data/${path.join("/")}`;
				}
				break;
			}
			case "case-ref":
				out += `#${part.caseType}/${part.property}`;
				break;
			case "user-ref":
				out += `#user/${part.property}`;
				break;
			case "user-property-ref": {
				const slug = ctx.userPropertySlug(part.userPropertyUuid);
				if (slug === undefined) {
					unresolved.push({
						kind: part.kind,
						identity: part.userPropertyUuid,
					});
					out += "#user/[reference needs repair]";
				} else {
					out += `#user/${slug}`;
				}
				break;
			}
			case "search-answer-ref": {
				const name = ctx.searchInputName(part.searchInputUuid);
				if (name === undefined) {
					unresolved.push({
						kind: part.kind,
						identity: part.searchInputUuid,
					});
					out += "#search/[reference needs repair]";
				} else {
					out += `#search/${name}`;
				}
				break;
			}
			default: {
				const _exhaustive: never = part;
				break;
			}
		}
	}
	return unresolved.length === 0
		? { ok: true, text: out }
		: { ok: false, text: out, unresolved };
}

/**
 * Strict projection for wire/runtime callers. Human editors should use
 * `projectXPath` and render its repair text when `ok` is false.
 */
export function printXPath(
	expr: XPathExpression,
	ctx: XPathPrintContext,
): string {
	const projected = projectXPath(expr, ctx);
	if (!projected.ok) throw new XPathProjectionError(projected.unresolved);
	return projected.text;
}
