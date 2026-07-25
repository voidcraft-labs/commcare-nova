// lib/domain/formLinkProjection.ts
//
// The ONE derivation of what each end-of-form link's guard actually is.
//
// CommCare's runtime does not pick a winner among matching links. Every
// `<create>` whose `if` evaluates true pushes its own frame
// (`commcare-core .../session/CommCareSession.java::createFrame` →
// `pushNewFrame`), and frames pop LIFO (`::finishAndPop`, over a
// `java.util.Stack`). So two matching links send the worker to the SECOND
// one and then, on leaving it, to the first. "The user will be sent to the
// first module/form whose expression evaluates to true" is what HQ's own
// `FormLink` docstring promises and what neither HQ nor Nova emitted:
// `commcare-hq .../suite_xml/post_process/workflow.py::EndOfFormNavigationWorkflow._get_link_frame`
// passes `link.xpath` through unchanged.
//
// Exclusivity is therefore something the EMITTED GUARD has to carry:
// link i fires on its own condition AND on none of its predecessors'.
// That is the whole of this module, and it is shared rather than
// duplicated because three surfaces must agree on it exactly — local
// suite.xml emission, the HQ JSON expander (whose per-link `xpath` HQ
// re-emits verbatim; `workflow.py` never runs `interpolate_xpath` over
// it), and the running preview.
//
// Composition happens on the Predicate AST, never by concatenating
// `not(...)` around printed text: the printer stays the single emission
// authority, and a negated subtree keeps its typed references so a rename
// still cannot rot it.
//
// ## The exhaustive `else`
//
// A terminal unconditional link IS the else branch. Its guard is the
// negation of every earlier condition, and it makes the post-submit
// fallback unreachable — so the fallback frame is suppressed rather than
// emitted with a guard that can never hold. An absent condition and a
// condition that reduces to always-true are the same state, which is why
// every read here goes through `effectiveDisplayConditionForEmission`
// instead of testing whether the slot is present.
//
// The two fallback derivations agree by algebra, which is what lets Nova
// emit chained guards on the HQ path even though HQ builds its own
// fallback from them. HQ negates the guards it is given
// (`_get_fallback_frame`), so it computes `¬G1 ∧ … ∧ ¬Gn`; since the `Gi`
// partition the `Ci` (⋁Gi ≡ ⋁Ci), that is exactly `¬C1 ∧ … ∧ ¬Cn` — the
// guard this module hands the local emitter.

import { type FormLink, orderedFormLinks } from "./forms";
import { and, matchNone, not } from "./predicate/builders";
import { effectiveDisplayConditionForEmission } from "./predicate/simplify";
import type { Predicate } from "./predicate/types";

/** One link paired with the condition it actually fires on. */
export interface ProjectedFormLink {
	readonly link: FormLink;
	/**
	 * The link's own effective condition — `undefined` when the link is
	 * unconditional, whether because the slot is absent or because the
	 * stored condition reduces to always-true.
	 */
	readonly own: Predicate | undefined;
	/**
	 * The condition to emit as this frame's `if`. `undefined` means the
	 * frame carries NO `if` attribute — which is not the same as an empty
	 * one: `if=""` reaches `XPathParseTool.parseXPath("")` in
	 * `commcare-core .../suite/model/StackOperation.java` and fails the
	 * whole suite parse. HQ folds a falsy clause to `None` the same way
	 * (`workflow.py::StackFrameMeta.__init__`).
	 */
	readonly guard: Predicate | undefined;
}

export interface FormLinkProjection {
	readonly links: readonly ProjectedFormLink[];
	/**
	 * The guard for the post-submit fallback frame, or `undefined` when no
	 * fallback frame is emitted at all — either because a terminal
	 * unconditional link already covers every case, or because there is no
	 * conditional link for the fallback to complement.
	 */
	readonly fallbackGuard: Predicate | undefined;
	/**
	 * Whether an unconditional link is what makes the fallback unreachable.
	 * The authoring surface reads this to decide whether the last row of
	 * the list is an author-chosen terminal link or the "Otherwise" row
	 * bound to `postSubmit`.
	 */
	readonly fallbackSuppressed: boolean;
}

/**
 * `and` over a list, then normalized the way every emission surface reads
 * a condition slot: `undefined` for "no guard", the always-false sentinel
 * preserved (it is a real, emittable `false()`), everything else
 * simplified. Doing it here rather than at each call site is what stops
 * one emitter from writing `if="match-all() and X"` while another folds it.
 */
function conjoinForEmission(
	clauses: readonly Predicate[],
): Predicate | undefined {
	if (clauses.length === 0) return undefined;
	const combined =
		clauses.length === 1
			? clauses[0]
			: and(clauses[0], clauses[1], ...clauses.slice(2));
	return effectiveDisplayConditionForEmission(combined);
}

/**
 * Derive every link's exclusive guard plus the fallback's, in canonical
 * `(order, uuid)` sequence.
 *
 * Total over every state the schema admits, including ones the commit
 * gate refuses: a link sitting AFTER an unconditional one is unreachable,
 * and its guard is the always-false sentinel rather than a silently
 * dropped frame. The validator rejects that document, so the shape exists
 * only to keep this function a total projection of the doc rather than a
 * second place where legality is decided.
 */
export function projectFormLinks(form: {
	readonly formLinks?: readonly FormLink[];
}): FormLinkProjection {
	const ordered = orderedFormLinks(form);
	const links: ProjectedFormLink[] = [];
	/* Negated predecessors, accumulated in sequence. An unconditional
	 * predecessor contributes `not(always)` — the absorbing sentinel — so
	 * everything after it projects to always-false without a special case. */
	const priorNegations: Predicate[] = [];
	let sawUnconditional = false;

	for (const link of ordered) {
		const own = effectiveDisplayConditionForEmission(link.condition);
		const guard = sawUnconditional
			? matchNone()
			: conjoinForEmission(
					own === undefined ? priorNegations : [own, ...priorNegations],
				);
		links.push({ link, own, guard });
		if (own === undefined) {
			sawUnconditional = true;
			continue;
		}
		priorNegations.push(not(own));
	}

	/* No conditional link means nothing to fall back FROM: either there are
	 * no links at all (the caller emits the plain post-submit stack) or an
	 * unconditional link always fires. */
	const fallbackGuard = sawUnconditional
		? undefined
		: conjoinForEmission(priorNegations);

	return { links, fallbackGuard, fallbackSuppressed: sawUnconditional };
}

/**
 * Whether a link fires no matter what — the shape that makes it the
 * exhaustive `else` and suppresses the fallback. Shared with the
 * validator so "unconditional" means one thing across authoring,
 * emission, and preview.
 */
export function isUnconditionalFormLink(link: FormLink): boolean {
	return effectiveDisplayConditionForEmission(link.condition) === undefined;
}
