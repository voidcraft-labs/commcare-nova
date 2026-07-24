// lib/preview/engine/displayConditionEvaluation.ts
//
// Client-side execution of module/form navigation display conditions
// at navigation render — the preview counterpart of the wire's
// `<menu relevant>` / `<command relevant>` attributes. The printing
// path is the SAME shared on-device predicate emitter the suite
// emitters use (raw comparisons — an absent value string-unpacks to
// "" and numeric-coerces to NaN; no presence guards), so preview and
// device can't diverge; the one preview-specific arm is the
// self-property leaf, printed as a `#case/<prop>` hashtag the
// evaluation context resolves against the selected row's projection
// (the identical projection the form engine's case reads use).
//
// Three-valued visibility: `shown` / `hidden` are evaluated results;
// `pending` means the condition folds over lookup data the builder
// session is still loading — the caller renders a placeholder, never
// a guess. With loaded data, unavailable lookup identities and any
// other checker-gated impossibility throw loudly (a bug surface,
// never a silently-shown item).

import { emitCaseListFilter } from "@/lib/commcare/predicate";
import type { Predicate } from "@/lib/domain/predicate";
import { effectiveDisplayConditionForEmission } from "@/lib/domain/predicate";
import { toBoolean } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import type { EvalContext } from "../xpath/types";
import type { PreviewSearchSessionValues } from "./identity";
import {
	foldTableLookupsInPredicate,
	predicateReferencesTableLookup,
} from "./lookupEvaluation";
import { sessionInstancePathValue } from "./searchExpressionEvaluation";
import type { PreviewLookupStatus } from "./useLookupPreviewData";

export type NavigationItemVisibility = "shown" | "hidden" | "pending";

/**
 * Module conditions gate the home screen's module list. They run
 * before any case selection — session/user identity values only (the
 * validator closes the context) — so no case projection exists.
 */
export function moduleDisplayVisibility(args: {
	readonly condition: Predicate | undefined;
	readonly session: PreviewSearchSessionValues;
	readonly currentCaseType?: string;
	readonly lookup: PreviewLookupStatus;
}): NavigationItemVisibility {
	return conditionVisibility({ ...args, caseProjection: undefined }, false);
}

/**
 * Form conditions gate the case-list screen's post-selection form
 * menu (including the single-form auto-continue) and the module
 * screen's forms-first list. Direct self properties of the selected
 * case resolve from `caseProjection` — the selected row's flattened
 * property bag (`caseRowToFormPreload`); the forms-first flow has no
 * selection and passes none (the validator already rejects property
 * reads there).
 */
export function formDisplayVisibility(args: {
	readonly condition: Predicate | undefined;
	readonly session: PreviewSearchSessionValues;
	readonly currentCaseType?: string;
	readonly caseProjection?: ReadonlyMap<string, string>;
	readonly lookup: PreviewLookupStatus;
}): NavigationItemVisibility {
	return conditionVisibility(args, true);
}

function conditionVisibility(
	args: {
		readonly condition: Predicate | undefined;
		readonly session: PreviewSearchSessionValues;
		readonly currentCaseType?: string;
		readonly caseProjection?: ReadonlyMap<string, string>;
		readonly lookup: PreviewLookupStatus;
	},
	allowSelfProperty: boolean,
): NavigationItemVisibility {
	// The shared "deeply always-true emits nothing" decision — an absent
	// or vacuous condition is simply shown, matching the absent wire attr.
	const effective = effectiveDisplayConditionForEmission(args.condition);
	if (effective === undefined) return "shown";

	if (
		predicateReferencesTableLookup(effective) &&
		args.lookup.kind === "loading"
	) {
		return "pending";
	}

	const ctx = navigationEvalContext(args.session, args.caseProjection);
	const emitSelfProperty = allowSelfProperty
		? (property: { readonly property: string }) => `#case/${property.property}`
		: undefined;
	const folded =
		args.lookup.kind === "data"
			? foldTableLookupsInPredicate(effective, args.lookup.data, {
					outer: ctx,
					...(emitSelfProperty !== undefined && { emitSelfProperty }),
				})
			: effective;
	const emitted = emitCaseListFilter(
		folded,
		"casedb",
		{
			...(args.currentCaseType !== undefined && {
				currentCaseType: args.currentCaseType,
			}),
		},
		undefined,
		emitSelfProperty === undefined ? {} : { emitSelfProperty },
	);
	return toBoolean(evaluate(emitted, ctx)) ? "shown" : "hidden";
}

/** Session paths resolve from the preview identity; `#case/<prop>`
 *  hashtags resolve from the selected row's projection with absent
 *  reading blank — the device's missing-property semantic. */
function navigationEvalContext(
	session: PreviewSearchSessionValues,
	caseProjection: ReadonlyMap<string, string> | undefined,
): EvalContext {
	return {
		contextPath: "",
		position: 1,
		size: 1,
		getValue: (path) => sessionInstancePathValue(path, session),
		resolveHashtag: (ref) => {
			const match = /^#case\/(.+)$/.exec(ref);
			if (match) return caseProjection?.get(match[1]) ?? "";
			return "";
		},
	};
}
