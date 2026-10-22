// lib/preview/searchClaims.ts
//
// When the running app claims a searched case, and which ids it claims.
//
// A search reads past the worker's restore (`QueryArgs.searchPopulation`), so
// a chosen result can be a case the worker's device does not hold. CommCare
// then posts a claim, and HQ answers by creating an extension case the worker
// owns, so the device holds the chosen case from its next restore
// (`lib/commcare/suite/case-search/claim.ts`). The post skips a case the
// device already holds (its `relevant` / `exclude`), which is why each
// search row says whether the device holds it and only an unheld choice is
// `claimable`.
//
// Core posts at the entry's sync request (`CommCareSession.getNeededData`):
// a search action's claim is its remote request's own `<post>`, posted as
// soon as the result is chosen; a search-first module's claim sits in each
// form's entry, posted once a form is chosen. Under a selected parent the
// form's post also offers every other case datum of the entry
// (`buildInlineClaimPost`'s `parentSelect`).

import type { BlueprintDoc, Uuid } from "@/lib/domain";
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

/** The ids a claim for these choices adds, in choice order. */
export function claimableCaseIds(
	choices: readonly PreviewCaseChoice[],
): string[] {
	return choices
		.filter((choice) => choice.claimable === true)
		.map((choice) => choice.caseId);
}

/**
 * The other case datums a search-first module's form claim offers: the cases
 * chosen for each module the module selects its parent through, nearest
 * first. None for a module with no parent selection.
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
 * conditions read a device that holds the claimed cases. Until the snapshot
 * holds every one of them, this reads as still loading, and each condition
 * that reads the device's cases waits (`pending`) rather than reading a
 * claimed case as missing.
 */
export function deviceCasesHoldingClaims(
	deviceCases: NavigationDeviceCases,
	claimedCaseIds: readonly string[],
): NavigationDeviceCases {
	const snapshot = deviceCases.snapshot;
	if (snapshot === null || claimedCaseIds.length === 0) return deviceCases;
	const held = new Set(snapshot.rows.map((row) => row.case_id));
	return claimedCaseIds.every((caseId) => held.has(caseId))
		? deviceCases
		: { snapshot: null, caseTypes: deviceCases.caseTypes };
}
