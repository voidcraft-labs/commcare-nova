// lib/preview/engine/displayConditionEvaluation.ts
//
// Client-side execution of module/form navigation display conditions
// at navigation render — the preview counterpart of the wire's
// `<menu relevant>` / `<command relevant>` attributes. The printing
// path is the SAME shared on-device predicate emitter the suite
// emitters use (raw comparisons — an absent value string-unpacks to
// "" and numeric-coerces to NaN; no presence guards), so preview and
// device can't diverge; the one preview-specific arm is the
// self-property leaf, printed to a private context path the
// local context resolves against the selected row's projection. This is not
// Nova authoring text; the typed expression remains the only stored input.
//
// An item off the menu (`hiddenFromMenu`) is `hidden` before its condition is
// read: no menu lists it on either runtime, and the condition applies only
// once it is back on the menu. Every other condition is evaluated exactly as
// stored (`displayConditionForEmission`), with no clause absorbed.
//
// Three-valued visibility: `shown` / `hidden` are evaluated results;
// `pending` means the condition folds over lookup data the builder
// session is still loading — the caller renders a placeholder, never
// a guess. With loaded data, unavailable lookup identities and any
// other checker-gated impossibility throw loudly (a bug surface,
// never a silently-shown item).

import { w } from "@/lib/commcare/xpath/wire/builders";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import { displayConditionForEmission } from "@/lib/domain/expression";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import { toBoolean } from "../xpath/coerce";
import { evaluate } from "../xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "../xpath/generatedJavaRosaFunctions";
import type { EvalContext } from "../xpath/types";
import {
	type PreviewSearchSessionValues,
	previewUserPropertySlugMap,
} from "./identity";
import {
	foldTableLookupsInPredicate,
	predicateLookupsCovered,
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
	readonly condition: Expression | undefined;
	readonly types: ExpressionContext;
	/** The module is off the menu: hidden whatever its condition says. */
	readonly hiddenFromMenu?: boolean;
	readonly session: PreviewSearchSessionValues;
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
	readonly condition: Expression | undefined;
	readonly types: ExpressionContext;
	/** The form is off the menu: hidden whatever its condition says. */
	readonly hiddenFromMenu?: boolean;
	readonly session: PreviewSearchSessionValues;
	readonly caseProjection?: ReadonlyMap<string, string>;
	readonly lookup: PreviewLookupStatus;
}): NavigationItemVisibility {
	return conditionVisibility(args, true);
}

function conditionVisibility(
	args: {
		readonly condition: Expression | undefined;
		readonly types: ExpressionContext;
		readonly hiddenFromMenu?: boolean;
		readonly session: PreviewSearchSessionValues;
		readonly caseProjection?: ReadonlyMap<string, string>;
		readonly lookup: PreviewLookupStatus;
	},
	allowSelfProperty: boolean,
): NavigationItemVisibility {
	if (args.hiddenFromMenu === true) return "hidden";
	// The emitters' own decision: an absent condition, or one whose root is
	// always, is simply shown, matching the absent wire attribute. Every
	// other condition is evaluated as stored.
	const effective = displayConditionForEmission(args.condition);
	if (effective === undefined) return "shown";
	if (args.session.identityPending) return "pending";

	/* A carrier-bearing condition is decidable only over a snapshot that
	 * COVERS its identities — a bare "data exists" test is not enough,
	 * because the stale-while-revalidate snapshot predates a validly
	 * committed reference to a new table/column. Loading, a failed
	 * fetch, the first-render idle tick, and the stale-coverage window
	 * all render the placeholder — never a guess, never a crash for a
	 * transient; a COVERED snapshot with a broken identity still throws
	 * loudly below (a genuine validator bypass). */
	const data = args.lookup.kind === "data" ? args.lookup.data : undefined;
	if (!predicateLookupsCovered(effective, data)) {
		return "pending";
	}

	const ctx = navigationEvalContext(args.session, args.caseProjection);
	const emitSelfProperty = allowSelfProperty
		? (property: { readonly property: string }) =>
				w.context([w.step("__nova_selected_case"), w.step(property.property)])
		: undefined;
	const folded =
		data !== undefined
			? foldTableLookupsInPredicate(effective, data, {
					types: args.types,
					outer: ctx,
					userPropertySlugs: previewUserPropertySlugMap(args.session),
					...(emitSelfProperty !== undefined && { emitSelfProperty }),
				})
			: effective;
	const emitted = serializeWire(
		toWire(folded, {
			target: "suite",
			types: args.types,
			bindings: {
				userPropertySlugs: previewUserPropertySlugMap(args.session),
				...(emitSelfProperty === undefined ? {} : { emitSelfProperty }),
			},
		}),
		{ target: "suite" },
	).text;
	return toBoolean(evaluate(emitted, ctx)) ? "shown" : "hidden";
}

/** Session paths resolve from the preview identity; the private self-property
 * token resolves from the selected row's projection with absent reading blank
 * — the device's missing-property semantic. */
function navigationEvalContext(
	session: PreviewSearchSessionValues,
	caseProjection: ReadonlyMap<string, string> | undefined,
): EvalContext {
	return {
		contextPath: "",
		position: 1,
		getValue: (path) =>
			path.startsWith("/__nova_selected_case/")
				? (caseProjection?.get(path.slice("/__nova_selected_case/".length)) ??
					"")
				: sessionInstancePathValue(path, session),
		resolveInstance: (instanceId, path) =>
			instanceId === "commcaresession"
				? { kind: "supported", value: sessionInstancePathValue(path, session) }
				: { kind: "unsupported" },
		resolveHashtag: () => "",
		invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
	};
}
