/**
 * Form-context-aware hashtag expansion.
 *
 * The flat resolver in `lib/commcare/hashtags.ts` handles `#form/` and
 * `#user/`. A per-case-type namespace (`#<case_type>/<prop>`) needs to know
 * which case the form loads and how far up the parent-index chain the named
 * type sits, so this module supplies that form context. Literal authored
 * `#case/...` is not a Nova reference and is rejected here.
 *
 * Resolution by namespace:
 *
 *   - `#form/` — canonical field paths projected to emitted data paths; `#user/` uses a flat prefix.
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
 * with a defined meaning is `case_id` (own type, hop depth 0), which reads that
 * same session datum: HQ's build sets the create block's `@case_id` from it
 * (`xform.py::XFormCaseBlock.add_create_block`), so the read and the block
 * hold one value on every runtime, and the read names no node of the case
 * block, which the stored source does not hold. The caller passes the datum's
 * session reference as `ownNewCaseIdRef`, built from
 * `session.ts::newCaseIdDatumId`. Every other own/ancestor case reference
 * on a registration form expands to the case-loading shape, so the
 * binding-resolution oracle catches the missing `case_id` datum at compile
 * time; the deep validator rejects it first at authoring time.
 *
 * Session scope ({@link expandHashtagsForSessionStack}) is different: an
 * after-submit link runs after the form has closed, when a registration
 * form's new case EXISTS and the entry's create datum
 * (`case_id_new_<type>_0`) names it. So the session-scope walk anchors at
 * whichever datum the source entry carries for its own case — the caller
 * names it — and `#<own>/case_id` IS that datum. No narrowing applies; the
 * read-side rule is `caseRefAcceptMap(index, formType, "session")`.
 *
 * {@link expandHashtagsForDefaultValue} is the same walk for a default value,
 * where every form read is printed relative to the question it sets, and
 * {@link vellumShorthandInContext} is the companion projection for the
 * `vellum:*` SHADOW attributes, which carry `#form/` references alone.
 */

import {
	CURRENT_CASE_ID,
	expandCaseToWire,
	resolveFlatHashtag,
	rewriteHashtags,
} from "@/lib/commcare/hashtags";
import { parser } from "@/lib/commcare/xpath/parser";
import { type CaseType, reachableCaseTypes } from "@/lib/domain";
import { type FormPath, originalContextPath } from "../xform/formPath";

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
	/** Canonical authored field path to emitted data path, including query-repeat item steps. */
	readonly formPaths?: ReadonlyMap<string, FormPath>;
	/** Session reference of the form's selected own case. Child root menus may
	 * rename it from the flat `case_id` default. */
	readonly currentCaseIdRef?: string;
	/**
	 * Session reference of the datum a registration form's entry mints its
	 * new case's id into (`instance('commcaresession')/session/data/
	 * case_id_new_<own type>_0`). `#<own type>/case_id` on a registration
	 * form reads it. Absent on every other form.
	 */
	readonly ownNewCaseIdRef?: string;
	/**
	 * The search answers a no-matches registration form can read: the
	 * search-input instance of the inline search that found nothing, and
	 * the prompt names it holds. Absent on every other form, where
	 * `#search/` is left verbatim for the validator to quote.
	 */
	readonly searchAnswers?: {
		readonly instanceId: string;
		readonly names: ReadonlySet<string>;
	};
}

/** The wire read of one search answer: `instance('<id>')/input/field[@name='<name>']`. */
export function searchAnswerWireRef(instanceId: string, name: string): string {
	return `instance('${instanceId}')/input/field[@name='${name}']`;
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
	return expandInContext(expr, ctx, (path) => path.toXPath());
}

/**
 * Expand a default value's hashtag references against the given form
 * context, printing every form read relative to `target`, the question the
 * default sets, as `current()/<relative steps>`.
 *
 * HQ's form builder refuses a `#form/` reference in a default ("You are
 * referencing a node in this form", Vellum `mugs/baseSpecs.js`
 * `defaultValue.validationFunc`) and turns an absolute `/data/` path into
 * one on load (`parser.js::parseSetValues`); it leaves a `current()/` path as
 * it is. Core evaluates a setvalue in its target's context, where
 * `current()` is the target (commcare-core `SetValueAction.processAction`),
 * so the relative read names the node the absolute one names, inside a
 * repeat row too. `current()` and not a bare `../`: a read inside a
 * predicate would otherwise start at the predicate's candidate.
 */
export function expandHashtagsForDefaultValue(
	expr: string,
	ctx: FormHashtagContext,
	target: FormPath,
): string {
	return expandInContext(expr, ctx, (path) =>
		originalContextPath(target, path),
	);
}

function expandInContext(
	expr: string,
	ctx: FormHashtagContext,
	printFormPath: (path: FormPath) => string,
): string {
	if (!expr) return expr;
	const isRegistration = ctx.formType === "registration";

	return rewriteHashtags(expr, (typeName, segments) => {
		// Field identities use the same paths as the emitted data nodes. Query-bound
		// repeats insert a wire-only item step that never belongs in authored refs.
		if (typeName === "form") {
			const path = ctx.formPaths?.get(segments.join("/"));
			if (path !== undefined) return printFormPath(path);
		}
		const flat = resolveFlatHashtag(typeName, segments);
		if (flat !== undefined) return flat;

		if (typeName === "case") {
			throw new Error(
				'Authored "#case/..." is not a Nova reference; use an explicit case-type namespace',
			);
		}

		// A search answer carried into the no-matches form. The namespace
		// is reserved (`RESERVED_CASE_TYPE_NAMES`), so it never names a case
		// type; outside that form it stays verbatim for the validator.
		if (typeName === "search") {
			const name = segments.length === 1 ? segments[0] : undefined;
			if (
				ctx.searchAnswers === undefined ||
				name === undefined ||
				!ctx.searchAnswers.names.has(name)
			) {
				return undefined;
			}
			return searchAnswerWireRef(ctx.searchAnswers.instanceId, name);
		}

		// Resolve the namespace to a parent-index hop count + the property path
		// read off the target case.
		const hops = ctx.caseTypeDepths.get(typeName);
		// Unreachable namespace — not a case this form can load. Leave it
		// verbatim; the deep validator rejects it by quoting the authored text.
		if (hops === undefined) return undefined;
		const propPath = segments.join("/");

		// Registration narrowing — the form's own new case isn't in casedb yet, so
		// only its allocated `case_id` (the loaded case, hop depth 0) resolves, to
		// the session datum the entry mints it into. The authoritative home of
		// this rule is the read-side accept map
		// `lib/domain/caseTypes.ts::caseRefAcceptMap`; keep the two in lockstep
		// (the wire layer stays below references, so it can't import it).
		if (isRegistration && hops === 0 && propPath === "case_id") {
			if (ctx.ownNewCaseIdRef === undefined) {
				throw new Error(
					"A registration form read its own new case's id, but the form context names no session datum for it. The caller builds that reference from session.ts::newCaseIdDatumId.",
				);
			}
			return ctx.ownNewCaseIdRef;
		}
		return expandCaseToWire(hops, propPath, ctx.currentCaseIdRef);
	});
}

/**
 * Expand authored case/user references for a suite post-form stack operation.
 * Core evaluates these expressions after the XForm has closed, in the entry's
 * session instance scope, so no `#form/...` or main `/data` projection exists.
 *
 * `ownCaseIdRef` is the session reference of the SOURCE entry's own case —
 * `instance('commcaresession')/session/data/case_id` on a case-loading form,
 * `…/case_id_new_<type>_0` on a registration form (its case exists once the
 * form has closed, and that datum is how the entry names it). Every typed
 * reference walks from it, and `#<own>/case_id` is that reference itself.
 */
export function expandHashtagsForSessionStack(
	expr: string,
	caseTypeDepths: ReadonlyMap<string, number>,
	ownCaseIdRef: string = CURRENT_CASE_ID,
): string {
	if (!expr) return expr;
	return rewriteHashtags(expr, (typeName, segments) => {
		if (typeName === "form") {
			throw new Error(
				"Form-link stack XPath cannot reference #form because the XForm instance is closed before Core evaluates it.",
			);
		}
		if (typeName === "user") {
			return resolveFlatHashtag(typeName, segments);
		}
		if (typeName === "case") {
			throw new Error(
				'Authored "#case/..." is not a Nova reference; use an explicit case-type namespace',
			);
		}
		if (typeName === "search") {
			throw new Error(
				"Form-link stack XPath cannot reference #search because the search-input instance belongs to the closed form's entry.",
			);
		}
		const hops = caseTypeDepths.get(typeName);
		if (hops === undefined) return undefined;
		const propPath = segments.join("/");
		if (hops === 0 && propPath === "case_id") return ownCaseIdRef;
		return expandCaseToWire(hops, propPath, ownCaseIdRef);
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
 * A shadow carries `#form/` references alone. Any other namespace in the
 * expression means no shadow, and the expanded real attribute round-trips as
 * plain XPath:
 *
 *   - A case read has no shadow because the editor's reverse map makes one
 *     itself. For a property HQ's schema lists, Vellum turns Nova's raw
 *     casedb path into `#case/<property>` on load and saves the same real
 *     attribute; an unlisted property or an attribute-backed read stays raw,
 *     draws no warning and is written back unchanged. A `#case/` shadow of
 *     Nova's own would be saved through the prefix transform as child
 *     elements the case database does not have for `status`, `case_id` and
 *     `owner_id` (`Vellum/src/xpath.js::hashtagToXPath`), and would be an
 *     unknown question for every property HQ's schema does not list
 *     (`logic.js::_addReferences`).
 *   - `#user/` and `#search/` are vocabulary the editor holds only
 *     conditionally, or never.
 *
 * A `#form/` reference that is the base of a predicate or the first step of
 * a longer path has no shadow either: the editor cannot parse
 * `#form/a[...]` or `#form/a/..`, writes the shadow verbatim into the real
 * attribute on save (`util.js::writeHashtags`), and HQ's next build fails.
 * The structure is read through the Lezer grammar, in the projected
 * expression.
 *
 * An expression with no hashtags at all needs no shadow → `undefined`.
 */
export function vellumShorthandInContext(
	expr: string,
	ctx: FormHashtagContext,
): string | undefined {
	if (!expr) return undefined;
	let sawHashtag = false;
	let untranslatable = false;

	const out = rewriteHashtags(expr, (typeName, segments) => {
		sawHashtag = true;
		// `#form/` is the editor's own namespace on every form.
		if (typeName === "form")
			return ctx.formPaths?.get(segments.join("/"))?.toVellum();
		untranslatable = true;
		return undefined;
	});

	if (!sawHashtag || untranslatable) return undefined;
	return hashtagHeadsAPath(out) ? undefined : out;
}

/** Whether a hashtag reference in `source` is the base of a predicate or the
 * first component of a longer `Child` or `Descendant` path. */
function hashtagHeadsAPath(source: string): boolean {
	let heads = false;
	parser.parse(source).iterate({
		enter(cursor) {
			if (heads) return false;
			if (cursor.name !== "HashtagRef") return;
			const node = cursor.node;
			const parent = node.parent;
			if (
				parent !== null &&
				(parent.name === "Filtered" ||
					parent.name === "Child" ||
					parent.name === "Descendant") &&
				parent.firstChild?.from === node.from &&
				parent.firstChild?.to === node.to
			)
				heads = true;
			return false;
		},
	});
	return heads;
}
