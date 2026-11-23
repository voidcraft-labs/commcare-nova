// components/builder/case-list-config/columnSources.ts
//
// The cases a property column can read its information from, for the
// column card's "From" picker: this case, each case above it along the
// catalog's parent chain, and the column's own walk where none of those is
// it. Pure, so the picker's offer is a function of the catalog alone.

import {
	type CaseType,
	type ColumnVia,
	columnPropertyCaseType,
	type PropertyColumn,
	sameColumnVia,
} from "@/lib/domain";
import { declaredCaseRelations } from "@/lib/domain/caseRelations";
import { humanizeId } from "@/lib/domain/idSlug";

/** One case a column can read from: its walk (none for this case), the case
 *  type it reaches, and what the picker calls it. */
export interface ColumnSource {
	readonly key: string;
	readonly via: ColumnVia | undefined;
	readonly caseType: string | undefined;
	readonly label: string;
}

/**
 * The cases a column can read from: this case, each case above it along the
 * catalog's parent chain (nearest first, stopping at a type met before), and
 * the column's own walk where none of those is it, so a walk through another
 * link stays on offer and shown.
 */
export function columnSources(
	currentCaseType: string | undefined,
	caseTypes: readonly CaseType[],
	current: ColumnVia | undefined,
): readonly ColumnSource[] {
	const sources: ColumnSource[] = [
		{
			key: "self",
			via: undefined,
			caseType: currentCaseType,
			label: "This case",
		},
	];
	const seen = new Set<string>(
		currentCaseType === undefined ? [] : [currentCaseType],
	);
	let at = currentCaseType;
	const steps: ColumnVia[number][] = [];
	for (;;) {
		const parent = caseTypes.find((type) => type.name === at)?.parent_type;
		if (parent === undefined || seen.has(parent)) break;
		seen.add(parent);
		steps.push({ identifier: "parent" });
		sources.push({
			key: `parent-${steps.length}`,
			via: [...steps] as ColumnVia,
			caseType: parent,
			label:
				steps.length === 1
					? `The ${parent} above it`
					: `The ${parent}, ${steps.length} steps above it`,
		});
		at = parent;
	}
	const origin = caseTypes.find((type) => type.name === currentCaseType);
	if (origin !== undefined) {
		const firstSteps = new Set(
			declaredCaseRelations(origin).map((edge) => edge.identifier),
		);
		for (const identifier of firstSteps) {
			if (
				sources.some(
					(source) =>
						source.via?.length === 1 && source.via[0].identifier === identifier,
				)
			)
				continue;
			const via: ColumnVia = [{ identifier }];
			const reached = columnPropertyCaseType(
				{ via },
				currentCaseType,
				caseTypes,
			);
			sources.push({
				key: `link-${identifier}`,
				via,
				caseType: reached,
				label:
					reached === undefined
						? `Related case through ${identifier}`
						: `${humanizeId(reached)} through ${identifier}`,
			});
		}
	}
	if (
		current !== undefined &&
		!sources.some((source) => sameColumnVia(source.via, current))
	) {
		const reached = columnPropertyCaseType(
			{ via: current },
			currentCaseType,
			caseTypes,
		);
		const links = current.map((step) => step.identifier).join(", then ");
		sources.push({
			key: "own",
			via: current,
			caseType: reached,
			label:
				reached === undefined
					? `Through ${links}`
					: `The ${reached}, through ${links}`,
		});
	}
	return sources;
}

/** The column reading `field` of the case `via` reaches, every other slot as
 *  it stands; no walk reads this case's own. */
export function columnWithSource<C extends PropertyColumn>(
	column: C,
	via: ColumnVia | undefined,
	field: string,
): C {
	const { via: _previous, ...rest } = column;
	return (
		via === undefined ? { ...rest, field } : { ...rest, field, via }
	) as C;
}
