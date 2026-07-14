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
 *
 * The module's second export, {@link vellumShorthandInContext}, is the
 * companion projection for the `vellum:*` SHADOW attributes: same form
 * context, but targeting HQ's editor vocabulary instead of executable XPath.
 */

import {
	expandCaseToWire,
	resolveFlatHashtag,
	rewriteHashtags,
	splitCaseSegments,
	VELLUM_CASE_GENERATION_PREFIXES,
} from "@/lib/commcare/hashtags";
import { type CaseType, reachableCaseTypes } from "@/lib/domain";

/**
 * The form-shape inputs the hashtag resolver needs.
 */
export interface FormHashtagContext {
	readonly formType: "registration" | "followup" | "close" | "survey";
	/**
	 * Case-type name → parent-index hop count from the form's own loaded case
	 * (own = 0, parent = 1, grandparent = 2, …). Built by the CALLER via
	 * {@link caseTypeDepthMap}. A `#<type>/<prop>` ref resolves by looking its
	 * namespace up here and reusing the parent-index walk `#case/parent…`
	 * already emits. Empty when the form has no case type.
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

/**
 * The form's readable case-type depth map, name → parent-index hop count
 * (own = 0, parent = 1, …), built from the module's case type. The ONE
 * construction both wire builders share — `xform/builder.ts::buildXForm`
 * resolves `#<type>/` refs through it and `formActions.ts::
 * buildCaseReferencesLoad` translates its load entries through it, and the
 * two MUST agree or the load map names a different case than the binds.
 */
export function caseTypeDepthMap(
	moduleCaseType: string | undefined,
	caseTypes: CaseType[],
): ReadonlyMap<string, number> {
	return new Map(
		reachableCaseTypes(moduleCaseType, caseTypes).map((t) => [t.name, t.depth]),
	);
}

/**
 * Project `expr` into HQ's EDITOR vocabulary for the `vellum:*` shadow
 * attributes, or return `undefined` when no shadow should be emitted.
 *
 * The form designer's hashtag vocabulary is fixed by HQ's data sources, and a
 * shadow spelled outside it is actively destructive: the editor's XPath engine
 * rejects an unknown namespace at parse (`Vellum/src/xpath.js::
 * isValidNamespace`), marks the whole expression unparseable, and re-serializes
 * it VERBATIM into the real attribute on the user's next save
 * (`util.js::writeHashtags`'s catch path) — raw hashtags on a wire that only
 * speaks XPath, failing HQ's next build. So a shadow emits ONLY when its
 * vocabulary is GUARANTEED present in the editor for this form; everything
 * else suppresses the shadow, and the expanded real attribute alone
 * round-trips as plain XPath (when the editor does know the vocabulary, its
 * reverse map re-derives the shorthand from the expansion).
 *
 * What HQ's editor is guaranteed to know, per form:
 *
 *   - `#form/` — always (`Vellum/src/form.js` seeds it unconditionally).
 *   - `#case/<prop>` (single plain segment) — whenever the form LOADS a case:
 *     `casedb_schema.py::get_casedb_schema` gates the case subsets on
 *     `form.requires_case()`, and generation 0 is unconditional inside that
 *     gate. Nova uploads `followup`/`close` forms with `requires: "case"`
 *     (`CASE_LOADING_FORM_TYPES`); registration and survey forms upload with
 *     `requires: "none"`, so even `#case/` is unknown vocabulary there.
 *
 * Everything else is only CONDITIONALLY present, so it never gets a shadow:
 *
 *   - `#user/` — gated on `domain_has_usercase_access(app.domain)`, a target-
 *     domain privilege Nova cannot know at emission time (off by default).
 *   - `#case/parent/` / `#case/grandparent/` (depth ≥ 1 refs, whether spelled
 *     per-type or as transitional `parent` chains) — HQ derives the parent
 *     generations from the app's own STRUCTURE, not from any catalog:
 *     `case_properties.py::get_case_relationships` collects case-subcase
 *     relationships "appearing in all relevant forms", so a catalog parent
 *     link with no in-app subcase form gives the editor no parent generation.
 *   - Nova's per-case-type namespaces, multi-segment properties, properties
 *     named after a relationship word — no editor spelling at all (the editor
 *     expands an unlisted hashtag by prefix up to its LAST slash,
 *     `Vellum/src/xpath.js::hashtagToXPath`).
 *
 * The head-element fallback can't rescue any of these: it is read only while
 * HQ's data sources load, and `Vellum/src/form.js::_updateHashtags` resets the
 * namespaces to `{form: true}` + data sources once they arrive.
 *
 * `onRef` (when provided) receives each translated ref alongside its expanded
 * XPath — both computed in this single parse pass — but ONLY when the whole
 * expression is translatable (i.e. exactly the refs a caller may publish as
 * head metadata). `#form/` refs are not reported: they expand to plain in-form
 * paths and carry no head metadata in vanilla output.
 *
 * An expression with no hashtags at all needs no shadow → `undefined`.
 */
export function vellumShorthandInContext(
	expr: string,
	ctx: FormHashtagContext,
	onRef?: (editorRef: string, expandedRef: string) => void,
): string | undefined {
	if (!expr) return undefined;
	const caseVocabulary =
		ctx.formType === "followup" || ctx.formType === "close";
	let sawHashtag = false;
	let untranslatable = false;
	const refs: Array<[editorRef: string, expandedRef: string]> = [];

	const out = rewriteHashtags(expr, (typeName, segments) => {
		sawHashtag = true;
		// `#form/` is the editor's own namespace on every form.
		if (typeName === "form") return undefined;

		const fail = (): undefined => {
			untranslatable = true;
			return undefined;
		};
		if (typeName === "user" || !caseVocabulary) return fail();

		let hops: number;
		let propSegments: string[];
		if (typeName === "case") {
			const { hops: caseHops, propPath } = splitCaseSegments(segments);
			hops = caseHops;
			propSegments = propPath === "" ? [] : propPath.split("/");
		} else {
			const depth = ctx.caseTypeDepths.get(typeName);
			if (depth === undefined) return fail();
			hops = depth;
			propSegments = segments;
		}

		// Only the guaranteed generation: the form's own loaded case (depth 0).
		if (hops !== 0 || propSegments.length !== 1) return fail();
		const prop = propSegments[0];
		if (prop === "parent" || prop === "grandparent") return fail();
		const editorRef = `${VELLUM_CASE_GENERATION_PREFIXES[0]}${prop}`;
		refs.push([editorRef, expandCaseToWire(0, prop)]);
		return editorRef;
	});

	if (!sawHashtag || untranslatable) return undefined;
	if (onRef)
		for (const [editorRef, expandedRef] of refs) onRef(editorRef, expandedRef);
	return out;
}
