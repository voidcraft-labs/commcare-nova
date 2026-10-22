/** One calendar-day search meaning for wire and Preview. */
import {
	isStandardCaseListProperty,
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
} from "../standardCaseProperties";
import {
	and,
	between,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	exists,
	gte,
	literal,
	lt,
	prop,
	term,
} from "./builders";
import type { ExpressionContext, RecordQueryContext } from "./context";
import { resolveRelationDestination } from "./relationDestination";
import { scalarDataType, typeOf } from "./typeChecker";
import type { Expression, RelationPath } from "./types";
export interface ExactDateSearchPredicateArgs {
	readonly caseType: string;
	readonly property: string;
	readonly via?: RelationPath;
	readonly day: Expression;
	readonly typeContext: ExpressionContext | RecordQueryContext;
}
export interface DateRangeSearchPredicateArgs {
	readonly caseType: string;
	readonly property: string;
	readonly via?: RelationPath;
	readonly lowerDay: Expression;
	readonly upperDay: Expression;
	readonly typeContext: ExpressionContext | RecordQueryContext;
}
export function exactDateSearchPredicate({
	caseType,
	property,
	via,
	day,
	typeContext,
}: ExactDateSearchPredicateArgs): Expression {
	const targetType = resolveTargetType(caseType, property, via, typeContext);
	const coerceBoundary =
		targetType === "datetime" ? datetimeCoerce : dateCoerce;
	const lower = coerceBoundary(day);
	const nextDay = dateAdd(dateCoerce(day), "days", term(literal(1)));
	const upper = targetType === "datetime" ? datetimeCoerce(nextDay) : nextDay;
	if (via === undefined || via.kind === "self") {
		const propertyRef = prop(caseType, property);
		return and(gte(propertyRef, lower), lt(propertyRef, upper));
	}
	const destinationCaseType = resolveDestinationCaseType(
		via,
		caseType,
		typeContext,
	);
	const destinationProperty = prop(destinationCaseType, property);
	return exists(
		via,
		and(gte(destinationProperty, lower), lt(destinationProperty, upper)),
	);
}
export function dateRangeSearchPredicate({
	caseType,
	property,
	via,
	lowerDay,
	upperDay,
	typeContext,
}: DateRangeSearchPredicateArgs): Expression {
	const targetType = resolveTargetType(caseType, property, via, typeContext);
	const buildClause = (propertyRef: ReturnType<typeof prop>): Expression => {
		if (targetType === "date") {
			return between(propertyRef, {
				lower: lowerDay,
				upper: upperDay,
			});
		}
		const lower = datetimeCoerce(lowerDay);
		const upper = datetimeCoerce(
			dateAdd(dateCoerce(upperDay), "days", term(literal(1))),
		);
		return and(gte(propertyRef, lower), lt(propertyRef, upper));
	};
	if (via === undefined || via.kind === "self") {
		return buildClause(prop(caseType, property));
	}
	const destinationCaseType = resolveDestinationCaseType(
		via,
		caseType,
		typeContext,
	);
	return exists(via, buildClause(prop(destinationCaseType, property)));
}
function resolveDestinationCaseType(
	via: Exclude<RelationPath, { kind: "self" }>,
	originCaseType: string,
	typeContext: ExpressionContext | RecordQueryContext,
): string {
	const result = resolveRelationDestination(
		via,
		originCaseType,
		typeContext.facts.caseTypes,
	);
	if (!result.ok)
		throw new Error(
			`Cannot derive a date search through the saved relationship: ${result.message}`,
		);
	return result.caseType;
}
function resolveTargetType(
	caseType: string,
	property: string,
	via: RelationPath | undefined,
	typeContext: ExpressionContext | RecordQueryContext,
): "date" | "datetime" {
	if (
		isStandardCaseListProperty(property) &&
		STANDARD_CASE_LIST_PROPERTY_DATA_TYPES[property] === "datetime"
	)
		return "datetime";
	const resolved = scalarDataType(
		typeOf(term(prop(caseType, property, via)), typeContext)?.data,
	);
	if (resolved === "date" || resolved === "datetime") return resolved;
	throw new Error(
		`Cannot search calendar days in "${property}" on "${caseType}": the saved property needs a date or date and time type.`,
	);
}
