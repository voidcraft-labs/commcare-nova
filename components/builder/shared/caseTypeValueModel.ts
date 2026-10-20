// components/builder/shared/caseTypeValueModel.ts
//
// The value side of a comparison with "Case type" (`case-row-type`): an
// existing case type of the app, picked as a value and stored as a
// `case-type` leaf. The types the compared row can be are listed first, so
// the common choice is at hand; every other type of the catalog follows,
// since a comparison that can never hold is still a valid rule.

import { caseTypeDisplays } from "./caseTypePickerModel";

export interface CaseTypeValueGroups {
	/** Types the compared row can be, in catalog order. */
	readonly likely: readonly string[];
	/** Every other case type of the app, in catalog order. */
	readonly others: readonly string[];
}

/** Split the catalog into the row's possible types and the rest. A possible
 * type the catalog no longer holds is not offered. */
export function caseTypeValueGroups(
	catalog: readonly string[],
	possible: readonly string[],
): CaseTypeValueGroups {
	const possibleSet = new Set(possible);
	return {
		likely: catalog.filter((name) => possibleSet.has(name)),
		others: catalog.filter((name) => !possibleSet.has(name)),
	};
}

/** The type a fresh comparison starts with: the first the row can be,
 * otherwise the catalog's first. Undefined only for an app with no case
 * types, where "Case type" has nothing to compare with. */
export function defaultCaseTypeValue(
	catalog: readonly string[],
	possible: readonly string[],
): string | undefined {
	const groups = caseTypeValueGroups(catalog, possible);
	return groups.likely[0] ?? groups.others[0];
}

/** The friendly label of each case type, with its stored name where two
 * names read the same. */
export function caseTypeValueLabel(
	name: string,
	catalog: readonly string[],
): string {
	const display = caseTypeDisplays(
		catalog.includes(name) ? catalog : [...catalog, name],
	).get(name);
	if (display === undefined) return name;
	return display.needsDisambiguation
		? `${display.label} (${name})`
		: display.label;
}
