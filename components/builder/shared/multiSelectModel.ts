import type { CaseType } from "@/lib/domain";
import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	type Literal,
	literal,
	type PropertyRef,
} from "@/lib/domain/expression";
import { resolveRelationDestination } from "./relationDestination";
export type MultiSelectPredicate = ExpressionOfKind<"multi-select-contains">;
export function multiSelectProperty(
	ref: PropertyRef,
	caseTypes: readonly CaseType[],
	currentCaseType?: string,
) {
	const origin = ref.caseType ?? currentCaseType;
	if (origin === undefined) return undefined;
	const destination =
		ref.via === undefined
			? origin
			: resolveRelationDestination(ref.via, origin, caseTypes);
	return caseTypes
		.find((caseType) => caseType.name === destination)
		?.properties.find((property) => property.name === ref.property);
}
export function replaceMultiSelectProperty(
	value: MultiSelectPredicate,
	next: PropertyRef,
	caseTypes: readonly CaseType[],
	currentCaseType?: string,
): Omit<MultiSelectPredicate, "property" | "values"> & {
	readonly property: PropertyRef;
	readonly values: [Literal, ...Literal[]];
} {
	const first = literal(
		multiSelectProperty(next, caseTypes, currentCaseType)?.options?.[0]
			?.value ?? "",
	);
	return { ...value, property: next, values: [first] };
}
export function replaceMultiSelectValues(
	value: MultiSelectPredicate,
	next: readonly Literal[],
): MultiSelectPredicate | undefined {
	const [first, ...rest] = next;
	if (first === undefined) return undefined;
	return { ...value, values: [first, ...rest] };
}
