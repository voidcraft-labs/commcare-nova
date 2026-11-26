import { slotContext } from "@/lib/domain/expression/context";
/**
 * Rule: `caseSearchConfig.searchButtonDisplayCondition` (the
 * predicate gating whether the search button renders) is a GLOBAL
 * predicate — no case-data reads — that type-checks against the
 * module's case-type schema map.
 *
 * The case-data guard mirrors `excludedOwnerIdsTypeCheck`: the
 * condition emits as the case-list Search action's `relevant`,
 * evaluated once against the session before any case is selected —
 * there is no row for a property or relationship read to read. The
 * on-device wire emits such a read as a bare relative path that
 * resolves blank, so the predicate silently collapses to comparing
 * against the empty string — a truth value the author never chose.
 * The shared domain walker (`predicateReadsCaseData`) rejects
 * property, count, exists, and missing reads at the gate; fixed
 * values and session/current-user values remain valid.
 *
 * Routes through the shared `moduleTypeContext` admission set + the
 * shared `formatPath` for AST-path suffixes + the shared
 * `checkExpression` dispatch — same shape every predicate-slot type-
 * check rule uses, varying only on (1) which slot it reads and (2)
 * the validation error code it emits.
 *
 * Routing through `checkExpression` covers orphan input refs
 * natively — the type checker pushes "Unknown search input
 * '<name>'." per orphan ref via `resolveTermType`'s `input` arm
 * when `ctx.knownInputs` is populated. No separate orphan-ref rule
 * is needed for the predicate slots.
 *
 * Short-circuits cleanly when `caseSearchConfig` is absent OR the
 * `searchButtonDisplayCondition` slot itself is omitted — no
 * predicate to check, no error.
 */

import {
	type BlueprintDoc,
	isOwnerOnlyCaseSearchConfig,
	type Module,
	type Uuid,
} from "@/lib/domain";
import { checkExpression } from "@/lib/domain/expression";
import { LOOKUP_FIXTURE_ID_PREFIX } from "../../../lookup/naming";
import { searchButtonUndeclaredInstances } from "../../../suite/case-search/buttonCondition";
import { type ValidationError, validationError } from "../../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";
import { formatPath } from "../case-list/shared";

/** What a condition reads, in Nova's words: the worker and the session, a
 *  lookup table by its id (the condition names it by that id, so the table
 *  is the one it reads; `identityLookupWireNaming`), places, or the cases on
 *  the device. */
function readWhat(instanceId: string): string {
	if (instanceId === "commcaresession")
		return "the current worker's or the session's information";
	if (instanceId === "locations") return "places";
	if (instanceId === "casedb") return "the cases on the device";
	if (instanceId.startsWith(`${LOOKUP_FIXTURE_ID_PREFIX}t_`))
		return `lookup table ${instanceId
			.slice(LOOKUP_FIXTURE_ID_PREFIX.length + 2)
			.replaceAll("_", "-")}`;
	return `instance('${instanceId}')`;
}

export function searchButtonDisplayConditionTypeCheck(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookupTables?: LookupTypeIndex,
): ValidationError[] {
	const condition =
		mod.caseSearchConfig === undefined ||
		isOwnerOnlyCaseSearchConfig(mod.caseSearchConfig)
			? undefined
			: mod.caseSearchConfig.searchButtonDisplayCondition;
	if (!condition) return [];
	const ctx = slotContext(
		doc,
		{
			entity: "module",
			uuid: moduleUuid,
			slot: "search_button_display_condition",
		},
		lookupTables ?? new Map(),
	);
	if (ctx === undefined)
		throw new Error("A saved Search expression has no owning slot.");
	const allErrors = semanticCheckErrors(checkExpression(condition, ctx));

	if (allErrors.some((error) => error.code === "case-data-unavailable")) {
		return [
			validationError(
				"CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE",
				"module",
				`Module "${mod.name}" has a search-button display condition that reads a case property or relationship, but the condition is evaluated once, before any case is selected, to decide whether the Search action shows. There is no case to read, so the reference resolves blank on every runtime and the condition silently collapses. Compose the condition from fixed values and current-user/session values; to narrow which cases appear, use the case list filter or a search input instead, or clear the condition to show the button unconditionally.`,
				{ moduleUuid, moduleName: mod.name },
				{
					slot: "caseSearchConfig.searchButtonDisplayCondition",
					surface: "search-button",
				},
			),
		];
	}

	const errors = allErrors.filter(
		(error) =>
			error.code !== "case-data-unavailable" &&
			error.code !== "search-answer-unavailable",
	);
	if (errors.length === 0) {
		// A condition with a finding of its own (an answer read where Search
		// has none) is not printed: the finding names it.
		if (allErrors.length > 0) return [];
		// HQ's build declares the instances an entry's datums, details and
		// frames read, never the Search action's `relevant`
		// (`buttonCondition.ts`), so a condition reading what the list does
		// not load stops the list on the device once HQ builds the app.
		let undeclared: readonly string[];
		try {
			undeclared = searchButtonUndeclaredInstances(doc, moduleUuid);
		} catch {
			// A condition the device printer refuses (a calendar date-add, a
			// value no device evaluates) is named by the on-device
			// compatibility rules (`dateAddOnDeviceCompatibility`,
			// `onDeviceExpressionCompatibility`); what it reads is moot.
			return [];
		}
		if (undeclared.length === 0) return [];
		return [
			validationError(
				"CASE_SEARCH_BUTTON_DISPLAY_CONDITION_NOT_ON_THE_LIST",
				"module",
				`Module "${mod.name}" has a search-button display condition that reads ${undeclared.map(readWhat).join(", ")}, which its case list doesn't load. CommCare HQ's build loads for a case list only what its selections, its forms' display conditions and their after-submit destinations read, never what the Search button's condition reads, so on the device the case list would stop once the app is on CommCare HQ. Base the condition on fixed values or today's date, or on information the list itself reads: give the case list a filter (or each form that shows it a display condition) over the same information, or set each form that shows the list to return to it after submit (postSubmit "previous"). Otherwise clear the condition to show the button always.`,
				{ moduleUuid, moduleName: mod.name },
				{
					reason: "instance-not-on-the-list",
					instances: undeclared.join(","),
					slot: "caseSearchConfig.searchButtonDisplayCondition",
					surface: "search-button",
				},
			),
		];
	}

	return errors.map((err) => {
		const at = formatPath(err.path);
		// Suffix the AST path when present — locates the offending
		// node inside the predicate. Reads as a sentence fragment
		// when concatenated to the per-rule message.
		const suffix = at ? ` (at ${at})` : "";
		return validationError(
			"CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			"module",
			`Module "${mod.name}" case-search button display condition has a type error${suffix}: ${err.message}. The slot must resolve to a boolean (the runtime hides the search button when the predicate evaluates false). Open \`caseSearchConfig.searchButtonDisplayCondition\` and adjust the operand at that path, or clear the condition to render the button unconditionally.`,
			{ moduleUuid, moduleName: mod.name },
			{
				...checkErrorDetails(err),
				slot: "caseSearchConfig.searchButtonDisplayCondition",
				surface: "search-button",
			},
		);
	});
}
