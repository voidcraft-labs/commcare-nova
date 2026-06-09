/**
 * Form-context-aware hashtag expansion.
 *
 * The context-free expander at `lib/commcare/hashtags.ts::expandHashtags`
 * resolves the flat namespaces (`#form/`, `#user/`) and the transitional
 * literal `#case/<X>`. It CANNOT resolve a per-case-type namespace
 * (`#<case_type>/<prop>`) — that needs to know which case the form loads and
 * how far up the parent-index chain the named type sits. This module supplies
 * that form context.
 *
 * Resolution by namespace:
 *
 *   - `#form/` / `#user/` — flat prefixes, identical in every form context.
 *   - `#case/<X>` — the loaded case, walking any leading `parent` segments
 *     through the case index (`expandCaseHashtag`). Kept as a transitional
 *     safety net for un-migrated references.
 *   - `#<case_type>/<prop>` — looks the namespace up in `caseTypeDepths` (the
 *     form's reachable case types, own = hop depth 0, parent = 1, …) and reuses
 *     the SAME `…/index/parent × depth …/<prop>` walk via `expandCaseToWire`.
 *     So `#<own_type>/<prop>` is byte-identical to `#case/<prop>` and
 *     `#<ancestor>/<prop>` is byte-identical to the matching
 *     `#case/parent…/<prop>`. A namespace absent from `caseTypeDepths` is
 *     unreachable — left verbatim so the deep validator
 *     (`validator/rules/form.ts`) can quote the authored text when rejecting it.
 *
 * Registration narrowing: on a case-create form the form's own new case isn't
 * in `casedb` at form-init (the entry declares `case_id_new_<casetype>_0`, and
 * the case lands in `casedb` only after submission). The one own-case reference
 * with a defined meaning is `case_id` (own type, hop depth 0), populated at
 * `/data/case/@case_id` by the setvalue chain `xform/caseBlocks.ts::addCaseBlocks`
 * emits — so `#case/case_id` and `#<own_type>/case_id` both rewrite there. Every
 * other own/ancestor case reference on a registration form expands to the
 * case-loading shape just as the context-free expander would, so the
 * binding-resolution oracle catches the missing `case_id` datum at compile time;
 * the deep validator rejects it first at authoring time.
 */

import {
	expandCaseToWire,
	resolveFlatHashtag,
	rewriteHashtags,
	splitCaseSegments,
} from "@/lib/commcare/hashtags";

/**
 * The form-shape inputs the hashtag resolver needs.
 */
export interface FormHashtagContext {
	readonly formType: "registration" | "followup" | "close" | "survey";
	/**
	 * Case-type name → parent-index hop count from the form's own loaded case
	 * (own = 0, parent = 1, grandparent = 2, …). Built by the CALLER from
	 * `lib/domain/caseTypes.ts::reachableCaseTypes`. A `#<type>/<prop>` ref
	 * resolves by looking its namespace up here and reusing the parent-index
	 * walk `#case/parent…` already emits. Empty when the form has no case type.
	 */
	readonly caseTypeDepths: ReadonlyMap<string, number>;
}

/**
 * Expand the hashtag references in `expr` against the given form context. See
 * the module header for the per-namespace resolution + registration narrowing
 * rules. Empty / whitespace-only input passes through unchanged.
 */
export function expandHashtagsInContext(
	expr: string,
	ctx: FormHashtagContext,
): string {
	if (!expr) return expr;
	const isRegistration = ctx.formType === "registration";

	return rewriteHashtags(expr, (typeName, segments) => {
		// `#form/` / `#user/` resolve identically in every form context.
		const flat = resolveFlatHashtag(typeName, segments);
		if (flat !== undefined) return flat;

		// Resolve the namespace to a parent-index hop count + the property path
		// read off the target case. The transitional literal `#case/` counts
		// leading `parent` index segments; a per-type namespace looks its depth up
		// in the form context.
		let hops: number;
		let propPath: string;
		if (typeName === "case") {
			({ hops, propPath } = splitCaseSegments(segments));
		} else {
			const depth = ctx.caseTypeDepths.get(typeName);
			// Unreachable namespace — not a case this form can load. Leave it
			// verbatim; the deep validator rejects it by quoting the authored text.
			if (depth === undefined) return undefined;
			hops = depth;
			propPath = segments.join("/");
		}

		// Registration narrowing — the form's own new case isn't in casedb yet, so
		// only its allocated `case_id` (the loaded case, hop depth 0) resolves, to
		// the form-local path the case-create scaffolding populates. The
		// authoritative home of this rule is the read-side accept map
		// `lib/domain/caseTypes.ts::caseRefAcceptMap`; keep the two in lockstep
		// (the wire layer stays below references, so it can't import it).
		if (isRegistration && hops === 0 && propPath === "case_id") {
			return "/data/case/@case_id";
		}
		return expandCaseToWire(hops, propPath);
	});
}
