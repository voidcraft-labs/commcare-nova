import type { CaseType } from "@/lib/domain";
import {
	type Literal,
	literal,
	multiSelectAll,
	multiSelectAny,
	type Predicate,
	type PropertyRef,
} from "@/lib/domain/predicate";
import { resolveRelationDestination } from "./relationDestination";
export type MultiSelectPredicate = Extract<
	Predicate,
	{ kind: "multi-select-contains" }
>;
export function multiSelectProperty(
	ref: PropertyRef,
	caseTypes: readonly CaseType[],
) {
	const destination =
		ref.via === undefined
			? ref.caseType
			: resolveRelationDestination(ref.via, ref.caseType, caseTypes);
	return caseTypes
		.find((caseType) => caseType.name === destination)
		?.properties.find((property) => property.name === ref.property);
}
export function replaceMultiSelectProperty(
	value: MultiSelectPredicate,
	next: PropertyRef,
	caseTypes: readonly CaseType[],
): MultiSelectPredicate {
	const first = literal(
		multiSelectProperty(next, caseTypes)?.options?.[0]?.value ?? "",
	);
	return value.quantifier === "all"
		? multiSelectAll(next, first)
		: multiSelectAny(next, first);
}
export function replaceMultiSelectValues(
	value: MultiSelectPredicate,
	next: readonly Literal[],
): MultiSelectPredicate | undefined {
	const [first, ...rest] = next;
	if (first === undefined) return undefined;
	return value.quantifier === "all"
		? multiSelectAll(value.property, first, ...rest)
		: multiSelectAny(value.property, first, ...rest);
}
