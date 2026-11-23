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
	USERCASE_CASE_TYPE,
	type UserProperty,
} from "@/lib/domain";
import {
	CASE_LIST_LINK_NAME_PATTERN,
	declaredCaseRelations,
} from "@/lib/domain/caseRelations";
import { withStandardCaseProperties } from "@/lib/domain/expression/context";
import { humanizeId } from "@/lib/domain/idSlug";
import { usercaseCaseType } from "@/lib/domain/usercase";

/** Case views may read the worker's own record, including worker information
 * declared in this app. It stays outside the types a menu can manage. */
export function caseViewWorkerRecord(
	properties: readonly UserProperty[],
): CaseType {
	const userProperties = Object.fromEntries(
		properties.map((property) => [property.uuid, property]),
	);
	const [record] = withStandardCaseProperties([
		usercaseCaseType({ userProperties }),
	]);
	if (!record)
		throw new Error("The case-view catalog lost the worker’s record.");
	return record;
}

/** One case a column can read from: its walk (none for this case), the case
 *  type it reaches, and what the picker calls it. */
export interface ColumnSource {
	readonly readFrom?: "worker-record";
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
		// A link HQ's column field can't hold (a dot, a leading underscore) or
		// one called user (HQ reads it as the worker's own information) is
		// never offered: the gate would refuse the column.
		const firstSteps = new Set(
			declaredCaseRelations(origin)
				.map((edge) => edge.identifier)
				.filter(
					(identifier) =>
						identifier !== "user" &&
						CASE_LIST_LINK_NAME_PATTERN.test(identifier),
				),
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
	sources.push({
		key: "worker",
		via: undefined,
		readFrom: "worker-record",
		caseType: USERCASE_CASE_TYPE,
		label: "The worker’s record",
	});
	return sources;
}

/** The column reading `field` of the case `via` reaches, every other slot as
 *  it stands; no walk reads this case's own. */
export function columnWithSource<C extends PropertyColumn>(
	column: C,
	via: ColumnVia | undefined,
	field: string,
	readFrom?: "worker-record",
	showOwner?: "name",
): C {
	const {
		via: _previous,
		readFrom: _oldSource,
		showOwner: _oldDisplay,
		...rest
	} = column;
	return {
		...rest,
		field,
		...(via && { via }),
		...(readFrom && { readFrom }),
		...(field === "owner_id" && showOwner && { showOwner }),
	} as C;
}
