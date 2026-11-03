// lib/preview/searchClaims.ts
//
// When the running app claims a searched case, and which ids it claims.
//
// A search reads past the worker's restore (`QueryArgs.searchPopulation`), so
// a chosen result can be a case the worker's device does not hold. CommCare
// then posts a claim, and HQ answers by creating an extension case the worker
// owns, so the device holds the chosen case from its next restore
// (`lib/commcare/suite/case-search/claim.ts`). Preview writes the same claim
// row (`claimSearchedCasesAction`). The post skips a case the device already
// holds (its `relevant` / `exclude`), which is why each search row says
// whether the device holds it and only an unheld choice is `claimable`.
//
// Core posts at the entry's sync request (`CommCareSession.getNeededData`):
// a search action's claim is its remote request's own `<post>`, posted as
// soon as the result is chosen; in a menu whose forms read the search
// (CommCare's inline search) the claim sits in each case form's entry, posted
// once a form is chosen (`entries.py::add_post_to_entry`). Under a selected
// parent the form's post also offers every other case datum of the entry
// (`buildInlineClaimPost`'s `parentSelect`).

import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	moduleFormsReadSearch,
	type Uuid,
} from "@/lib/domain";
import type { NavigationDeviceCases } from "@/lib/preview/engine/displayConditionEvaluation";
import type {
	PreviewCaseChoice,
	PreviewMenuCaseSelection,
} from "@/lib/session/types";

/** One chosen row as the running app carries it, marked `claimable` when a
 *  search found it and the worker's device does not hold it. */
export function previewCaseChoiceOf(row: {
	readonly case_id: string;
	readonly case_name: string;
	readonly heldOnDevice?: boolean;
}): PreviewCaseChoice {
	return {
		caseId: row.case_id,
		caseName: row.case_name,
		...(row.heldOnDevice === false && { claimable: true as const }),
	};
}

/** The ids a claim for these choices posts, in choice order, each once. */
export function claimableCaseIds(
	choices: readonly PreviewCaseChoice[],
): string[] {
	return [
		...new Set(
			choices
				.filter((choice) => choice.claimable === true)
				.map((choice) => choice.caseId),
		),
	];
}

/** Whether the module's claim posts at its chosen result: every menu whose
 *  forms do not read the search. A menu whose forms read the search posts it
 *  as a case form opens instead ({@link formEntryClaimChoices}). */
export function claimPostsAtResult(
	module: Parameters<typeof moduleFormsReadSearch>[0],
): boolean {
	return !moduleFormsReadSearch(module);
}

/**
 * The choices a form's entry claims: in a menu whose forms read the search,
 * when a case-loading form opens, the cases chosen for it and, under a
 * selected parent, the entry's other case datums
 * ({@link parentSelectClaimChoices}). None for any other form.
 */
export function formEntryClaimChoices(args: {
	readonly doc: Pick<BlueprintDoc, "modules" | "forms">;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly chosen: readonly PreviewCaseChoice[];
	readonly selections: Readonly<Record<string, PreviewMenuCaseSelection>>;
}): readonly PreviewCaseChoice[] {
	const mod = args.doc.modules[args.moduleUuid];
	const form = args.doc.forms[args.formUuid];
	if (
		mod === undefined ||
		form === undefined ||
		!moduleFormsReadSearch(mod) ||
		!CASE_LOADING_FORM_TYPES.has(form.type)
	)
		return [];
	return [
		...args.chosen,
		...parentSelectClaimChoices(args.doc, args.moduleUuid, args.selections),
	];
}

/**
 * The other case datums the form claim of a menu whose forms read the search
 * offers: the cases chosen for each module the module selects its parent
 * through, nearest first. None for a module with no parent selection.
 */
export function parentSelectClaimChoices(
	doc: Pick<BlueprintDoc, "modules">,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): readonly PreviewCaseChoice[] {
	const choices: PreviewCaseChoice[] = [];
	const seen = new Set<Uuid>([moduleUuid]);
	let current = doc.modules[moduleUuid]?.parentCaseModuleUuid;
	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		choices.push(...(selections[current]?.cases ?? []));
		current = doc.modules[current]?.parentCaseModuleUuid;
	}
	return choices;
}

/**
 * The device cases a decision made right after a claim reads. A claim posted
 * at the chosen result syncs before the form menu shows, so the menu's
 * conditions read a device that holds the claimed cases. While a claim is in
 * flight (`useClaimSearchedCases`'s `inFlightCaseIds`), and until the device
 * snapshot holds every one of its cases, this reads as still loading, and
 * each condition that reads the device's cases waits (`pending`) rather than
 * reading a claimed case as missing.
 */
export function deviceCasesHoldingClaims(
	deviceCases: NavigationDeviceCases,
	inFlightCaseIds: readonly string[],
): NavigationDeviceCases {
	const snapshot = deviceCases.snapshot;
	if (snapshot === null || inFlightCaseIds.length === 0) return deviceCases;
	const held = new Set(snapshot.rows.map((row) => row.case_id));
	return inFlightCaseIds.every((caseId) => held.has(caseId))
		? deviceCases
		: { snapshot: null, caseTypes: deviceCases.caseTypes };
}
