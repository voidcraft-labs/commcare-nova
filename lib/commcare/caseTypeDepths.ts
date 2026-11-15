import { ancestorIndex } from "@/lib/domain/advancedModule";
import type { BlueprintDoc, CaseType } from "@/lib/domain/blueprint";
import { reachableCaseTypes } from "@/lib/domain/caseTypes";

/**
 * The indices a form's read of each case type it can read walks from the
 * form's own case, own type first: the own type walks none, and each ancestor
 * one more than the type below it, under the index the app links that type to
 * its catalog parent by (`advancedModule.ts::ancestorIndex`). Its length is
 * the type's depth in `reachableCaseTypes`. One map serves the form's wire
 * reads, its case operations, after-submit links, HQ's case-load metadata,
 * Preview and the reader; no expression or emitted text is inspected.
 * `caseTypes` is the catalog whose `parent_type` chain is walked, the
 * document's own where absent.
 */
export function caseTypeHopMap(
	doc: BlueprintDoc,
	moduleCaseType: string | undefined,
	caseTypes: readonly CaseType[] = doc.caseTypes ?? [],
): ReadonlyMap<string, readonly string[]> {
	const hops = new Map<string, readonly string[]>();
	let below: string | undefined;
	let walked: readonly string[] = [];
	for (const type of reachableCaseTypes(moduleCaseType, caseTypes)) {
		if (below !== undefined)
			walked = [...walked, ancestorIndex(doc, below, type.name)];
		hops.set(type.name, walked);
		below = type.name;
	}
	return hops;
}
