import type { CaseType } from "../blueprint";
import { resolveRelationDestination } from "./relationDestination";
import type { Expression, PropertyRef, RelationPath } from "./types";
import { walkExpressionTerms } from "./walk";
export interface CasePropertyRename {
	readonly caseType: string;
	readonly oldName: string;
	readonly newName: string;
}
export type CasePropertyNameResolver = (
	caseType: string,
	property: string,
) => string | undefined;
/** Identity resolution is authoritative even for relation steps with no authored type hint. */
export function relationDestinationCaseType(
	via: RelationPath | undefined,
	originCaseType: string | undefined,
	caseTypes: readonly CaseType[],
): string | undefined {
	if (via === undefined || via.kind === "self") return originCaseType;
	const result = resolveRelationDestination(via, originCaseType, caseTypes);
	if (!result.ok) return undefined;
	return result.caseType;
}
function mappedProperty(
	ref: PropertyRef,
	resolve: CasePropertyNameResolver,
	caseTypes: readonly CaseType[],
): string | undefined {
	const destination = relationDestinationCaseType(
		ref.via,
		ref.caseType,
		caseTypes,
	);
	return destination === undefined
		? undefined
		: resolve(destination, ref.property);
}
/** Mutates an Immer draft and counts changed name-backed identities. */
export function mapCasePropertiesInExpression(
	expression: Expression,
	resolve: CasePropertyNameResolver,
	caseTypes: readonly CaseType[],
): number {
	let renamed = 0;
	walkExpressionTerms(expression, (term) => {
		if (term.kind !== "prop" && term.kind !== "form-case") return;
		const property =
			term.kind === "form-case"
				? resolve(term.caseType, term.property)
				: mappedProperty(term, resolve, caseTypes);
		if (property === undefined || property === term.property) return;
		term.property = property;
		renamed++;
	});
	return renamed;
}
export function renameCasePropertyInExpression(
	expression: Expression,
	rename: CasePropertyRename,
	caseTypes: readonly CaseType[],
): number {
	return mapCasePropertiesInExpression(
		expression,
		(caseType, property) =>
			caseType === rename.caseType && property === rename.oldName
				? rename.newName
				: undefined,
		caseTypes,
	);
}
