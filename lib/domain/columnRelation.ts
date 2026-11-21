// lib/domain/columnRelation.ts
//
// The case a property column reads. A column with no `via` shows a property
// of the list's own case; a column with one shows a property of the case its
// indices reach, whose type the catalog gives the walk exactly as it gives a
// `prop` read's (`expression/relationDestination.ts`): `parent` reaches the
// catalog's parent type and every other index the type its step names.

import type { CaseType } from "./blueprint";
import { resolveRelationDestination } from "./expression/relationDestination";
import { columnRelationPath, type PropertyColumn } from "./modules";

/**
 * The case type whose property the column shows: the list's own where it
 * walks nothing, the type its walk reaches otherwise, and undefined where
 * the walk reaches no single type (a `parent` step from a type with no
 * parent, another index naming no type) or the list has no case type.
 */
export function columnPropertyCaseType(
	column: Pick<PropertyColumn, "via">,
	listCaseType: string | undefined,
	caseTypes: readonly CaseType[],
): string | undefined {
	if (listCaseType === undefined) return undefined;
	if (column.via === undefined) return listCaseType;
	const destination = resolveRelationDestination(
		columnRelationPath(column),
		listCaseType,
		caseTypes,
	);
	return destination.ok ? destination.caseType : undefined;
}
