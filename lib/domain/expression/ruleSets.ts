import {
	type CasePropertyDataType,
	casePropertyDataTypes,
} from "../casePropertyTypes";
import { unhandledKindMessage } from "./errors";
import type { CheckError, ScalarType } from "./typeChecker";
import {
	type CheckPath,
	type ComparisonKind,
	type Expression,
	isConditionArm,
	type Literal,
	MATCH_MODES,
	type MatchMode,
} from "./types";
export const ANY_TYPE = "_any" as const;

export type ResolvedType = ScalarType;

export const ORDERED_TYPES: ReadonlySet<ResolvedType> = new Set<ResolvedType>([
	"int",
	"decimal",
	"date",
	"datetime",
]);

export const TIME_ORDERING_MESSAGE =
	"A time of day can't be compared with before or after. CommCare compares these as numbers and a time is not one, so the comparison would never be true. A date can be compared this way.";
const MATCH_PROPERTY_TYPES_TEXT_SHAPED: ReadonlySet<ResolvedType> =
	new Set<ResolvedType>(["text", "single_select", "multi_select"]);
const MATCH_PROPERTY_TYPES_FUZZY_DATE: ReadonlySet<ResolvedType> =
	new Set<ResolvedType>([
		"text",
		"single_select",
		"multi_select",
		"date",
		"datetime",
	]);
export const MATCH_PROPERTY_TYPES_BY_MODE: Record<
	MatchMode,
	ReadonlySet<ResolvedType>
> = {
	fuzzy: MATCH_PROPERTY_TYPES_TEXT_SHAPED,
	phonetic: MATCH_PROPERTY_TYPES_TEXT_SHAPED,
	"fuzzy-date": MATCH_PROPERTY_TYPES_FUZZY_DATE,
	"starts-with": MATCH_PROPERTY_TYPES_TEXT_SHAPED,
};

export function describe(t: ScalarType): string {
	return t === ANY_TYPE ? "null" : t;
}
export function isValueStorageAssignable(
	valueType: ResolvedType,
	destinationType: CasePropertyDataType,
): boolean {
	if (valueType === ANY_TYPE) return false;
	if (valueType === destinationType) return true;
	if (valueType === "int" && destinationType === "decimal") return true;
	return (
		(valueType === "text" || valueType === "single_select") &&
		(destinationType === "text" || destinationType === "single_select")
	);
}

export function isNumeric(t: ResolvedType): boolean {
	return t === "int" || t === "decimal";
}

export function isDateOrDatetime(t: ResolvedType): boolean {
	return t === "date" || t === "datetime";
}

export const TEXT_SHAPED_TYPES: ReadonlySet<ResolvedType> =
	new Set<ResolvedType>(["text", "single_select", "multi_select"]);

export function accumulateBranchType(
	agreed: ResolvedType | undefined,
	candidate: ResolvedType | undefined,
	errors: CheckError[],
	errorPath: CheckPath,
	errorPrefix: string,
): ResolvedType | undefined {
	if (candidate === undefined) return agreed;
	if (candidate === ANY_TYPE) return agreed ?? ANY_TYPE;
	if (agreed === undefined || agreed === ANY_TYPE) return candidate;
	if (typesCompatible(agreed, candidate)) return agreed;
	errors.push({
		path: errorPath,
		code: "branch-values",
		message: `${errorPrefix}; '${describe(candidate)}' is not comparable with the established '${describe(agreed)}'.`,
	});
	return agreed;
}

export function literalType(lit: Literal): ResolvedType {
	if (lit.data_type) return lit.data_type;
	if (lit.value === null) return ANY_TYPE;
	switch (typeof lit.value) {
		case "string":
			return "text";
		case "number":
			return Number.isInteger(lit.value) ? "int" : "decimal";
		case "boolean":
			return "text";
		default: {
			const _exhaustive: never = lit.value;
			throw new Error(
				unhandledKindMessage({
					where: "literalType",
					family: "literal value type (`typeof`)",
					received: typeof _exhaustive,
					knownKinds: ["string", "number", "boolean", "null"],
				}),
			);
		}
	}
}

export function typesCompatible(a: ResolvedType, b: ResolvedType): boolean {
	if (a === ANY_TYPE || b === ANY_TYPE) return true;
	if (a === b) return true;
	if ((a === "int" || a === "decimal") && (b === "int" || b === "decimal"))
		return true;
	if (a === "single_select" && b === "text") return true;
	if (a === "text" && b === "single_select") return true;
	if (a === "multi_select" && b === "text") return true;
	if (a === "text" && b === "multi_select") return true;
	return false;
}

export const ALL_RESOLVED_TYPES: readonly ResolvedType[] = [
	...casePropertyDataTypes,
	"boolean",
	ANY_TYPE,
] satisfies ResolvedType[];

export function compatibleTypesFor(
	t: ResolvedType | undefined,
): ReadonlySet<ResolvedType> {
	if (t === undefined) return new Set(ALL_RESOLVED_TYPES);
	return new Set(ALL_RESOLVED_TYPES.filter((u) => typesCompatible(t, u)));
}

export function comparisonObjectTypesFor(
	kind: ComparisonKind,
	t: ResolvedType | undefined,
): ReadonlySet<ResolvedType> {
	const compatible = compatibleTypesFor(t);
	if (kind === "eq" || kind === "neq") return compatible;
	return new Set(
		[...compatible].filter(
			(type) => type === ANY_TYPE || ORDERED_TYPES.has(type),
		),
	);
}

export function comparisonOperatorsFor(
	t: ResolvedType | undefined,
): ReadonlySet<ComparisonKind> {
	const all: ComparisonKind[] = ["eq", "neq", "gt", "gte", "lt", "lte"];
	if (t === undefined || t === ANY_TYPE || ORDERED_TYPES.has(t)) {
		return new Set(all);
	}
	return new Set<ComparisonKind>(["eq", "neq"]);
}

export function matchModesFor(
	t: ResolvedType | undefined,
): ReadonlySet<MatchMode> {
	if (t === undefined || t === ANY_TYPE) return new Set(MATCH_MODES);
	return new Set(
		MATCH_MODES.filter((m) => MATCH_PROPERTY_TYPES_BY_MODE[m].has(t)),
	);
}

export type ValueExpressionResultClass =
	| "numeric"
	| "text"
	| "date"
	| "datetime"
	| "date-or-datetime"
	| "int"
	| "depends";

export function valueExpressionKindResultClass(
	kind: Expression["kind"],
): ValueExpressionResultClass {
	switch (kind) {
		case "arith":
		case "negate":
		case "double":
			return "numeric";
		case "concat":
		case "format-date":
		case "id-of":
		case "acting-user":
		case "unowned":
			return "text";
		case "today":
			return "date";
		case "now":
			return "datetime";
		case "date-add":
			return "date-or-datetime";
		case "date-coerce":
			return "date";
		case "datetime-coerce":
			return "datetime";
		case "count":
			return "int";
		case "term":
		case "if":
		case "switch":
		case "coalesce":
		case "table-lookup":
			return "depends";
		default:
			// General expressions are resolved from their children and slot context.
			return "depends";
	}
}

export type RecordPosition = "condition" | "value";
export function recordPositionVerdict(
	kind: Expression["kind"],
	position: RecordPosition,
):
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: "value-expected" | "condition-expected";
	  } {
	if (kind === "if" || kind === "switch") return { ok: true };
	const condition = isConditionArm({ kind } as Expression);
	return condition === (position === "condition")
		? { ok: true }
		: {
				ok: false,
				reason:
					position === "condition" ? "condition-expected" : "value-expected",
			};
}

export type ExpressionResultClass = ValueExpressionResultClass;
