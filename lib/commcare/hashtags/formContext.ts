/**
 * Form-context-aware hashtag expansion.
 *
 * The context-free expander at `lib/commcare/hashtags.ts::expandHashtags`
 * rewrites every `#case/<X>` to the canonical case-loading XPath shape
 * (`instance('casedb')/casedb/case[@case_id = instance('commcaresession')/
 * session/data/case_id]/<X>`). That shape is correct for forms that load
 * an existing case (followup / close) — `session/data/case_id` is bound
 * to the chosen case, and the lookup resolves to the case's properties
 * in the case database.
 *
 * On a case-create form (registration) it isn't correct on either side:
 *
 *   - The form's session has no `case_id` datum. The case-creating
 *     entry's session datum is `case_id_new_<casetype>_0` (a `uuid()`
 *     function datum). `session/data/case_id` resolves to an empty
 *     node-set; JavaRosa rejects the calculate at form-init with
 *     `XPathTypeMismatchException`.
 *   - Even if the session var were correct, the case the form is
 *     creating isn't IN `casedb` yet — `casedb` only sees the case
 *     after submission.
 *
 * Resolution policy: on a registration form, `#case/case_id` is the one
 * `#case/` reference that has a defined meaning — it refers to the form's
 * own new case, whose id lives at `/data/case/@case_id` (populated by
 * the setvalue chain `compiler.ts::addCaseBlocks` emits from the
 * `case_id_new_<casetype>_0` session datum). Every other `#case/<X>` on a
 * case-create form is semantically wrong — those properties are being
 * SET by the form right now, not read from a pre-existing case — and the
 * validator rejects them at validation time, pointing the author at
 * `#form/<question_id>` or `/data/<question_id>` instead. This expander
 * leaves the rejected references un-rewritten so the validator's error
 * message can show the original authored text.
 *
 * On every other form type (followup / close / survey) the expansion is
 * identical to the context-free version.
 *
 * Future direction: the same resolver is the right home for case-type-
 * namespaced hashtags (`#patient/case_id`-style) — once that authoring
 * surface lands, the in-scope-case-types resolution joins the form
 * context here without a structural change to call sites.
 */

import { expandHashtags } from "@/lib/commcare/hashtags";
import { parser } from "@/lib/commcare/xpath";

/**
 * The form-shape inputs the hashtag resolver needs. Today only
 * `formType` is consulted; the interface is named for the broader
 * direction (in-scope case types, multi-case scope) so future extensions
 * don't churn the callers.
 */
export interface FormHashtagContext {
	readonly formType: "registration" | "followup" | "close" | "survey";
}

/** Pre-resolved parser node types used by the case-create rewriter. */
const T = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Missing parser node type: ${name}`);
		return found;
	};
	return {
		HashtagRef: one("HashtagRef"),
		HashtagType: one("HashtagType"),
		HashtagSegment: one("HashtagSegment"),
	};
})();

/**
 * Expand the hashtag references in `expr` against the given form
 * context. On a registration form, rewrites `#case/case_id` to
 * `/data/case/@case_id` (which the case-create scaffolding populates at
 * `xforms-ready`); leaves every other `#case/<X>` un-rewritten so the
 * validator's rejection error can quote the original authored form.
 * On every other form type, delegates to the context-free
 * {@link expandHashtags}.
 *
 * Empty / whitespace-only input passes through unchanged.
 */
export function expandHashtagsInContext(
	expr: string,
	ctx: FormHashtagContext,
): string {
	if (!expr) return expr;
	if (ctx.formType !== "registration") return expandHashtags(expr);

	// Two-pass on a registration form: rewrite `#case/case_id` to the
	// form-local path (the case-management scaffolding populates the
	// target at xforms-ready), then run the context-free expander to
	// handle every `#form/` and `#user/` reference. The context-free
	// pass leaves `#case/<X>` for X !== "case_id" un-rewritten — the
	// validator catches those.
	const afterCaseRewrite = rewriteCaseIdRefs(expr);
	return expandHashtags(afterCaseRewrite);
}

/**
 * Replace every `#case/case_id` HashtagRef with `/data/case/@case_id`.
 * Walks the Lezer parse tree to find the exact (type=case, segments=
 * ["case_id"]) shape rather than substring-matching the literal
 * `#case/case_id` — a label-prose match would also catch `#case/case_id_x`
 * by prefix and break the round-trip. Other `#case/<X>` references are
 * left in place; the validator emits a targeted error pointing the
 * author at `#form/<question_id>`.
 */
function rewriteCaseIdRefs(expr: string): string {
	const tree = parser.parse(expr);
	const edits: Array<{ from: number; to: number; text: string }> = [];

	tree.iterate({
		enter(node) {
			if (node.type !== T.HashtagRef) return;
			const ref = node.node;
			const type = ref.getChild(T.HashtagType.id);
			if (!type) return;
			if (expr.slice(type.from, type.to) !== "case") return;
			const segments = ref.getChildren(T.HashtagSegment.id);
			if (segments.length !== 1) return;
			if (expr.slice(segments[0].from, segments[0].to) !== "case_id") return;
			edits.push({ from: node.from, to: node.to, text: "/data/case/@case_id" });
			return false;
		},
	});

	if (edits.length === 0) return expr;
	let result = expr;
	for (let i = edits.length - 1; i >= 0; i--) {
		const { from, to, text } = edits[i];
		result = result.slice(0, from) + text + result.slice(to);
	}
	return result;
}
