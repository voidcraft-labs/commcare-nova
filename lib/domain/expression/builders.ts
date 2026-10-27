/** Typed constructors for the canonical expression vocabulary. */
import type {
	CasePropertyDataType,
	LookupColumnId,
	LookupTableId,
	Uuid,
} from "@/lib/domain";
import {
	reduceAnd as reduceAndImpl,
	reduceNot as reduceNotImpl,
	reduceOr as reduceOrImpl,
} from "./reduction";
import type {
	ArithOp,
	Choice,
	ComparisonKind,
	DateAddInterval,
	DistanceUnit,
	Expression,
	FixedLocationTerm,
	FormatDatePreset,
	FormFieldRef,
	Literal,
	MatchMode,
	OwnerLocationAtLevelTerm,
	PropertyRef,
	RelationPath,
	RelationStep,
	SearchInputRef,
	SessionContextField,
	SessionContextRef,
	SessionUserPropertyRef,
	SessionUserRef,
	SwitchCase,
	TableColumnTerm,
	Term,
} from "./types";
import { isTerm } from "./types";
export function toExpression(input: Term | Expression): Expression {
	return isTerm(input) ? { kind: "term", term: input } : input;
}
export function prop(
	caseType: string,
	property: string,
	via?: RelationPath,
): PropertyRef {
	return via === undefined
		? { kind: "prop", caseType, property }
		: { kind: "prop", caseType, property, via };
}
export function input(searchInputUuid: Uuid): SearchInputRef {
	return { kind: "input", searchInputUuid };
}
export function sessionUser(field: string): SessionUserRef {
	return { kind: "session-user", field };
}
export function sessionUserProperty(
	userPropertyUuid: Uuid,
): SessionUserPropertyRef {
	return { kind: "session-user-property", userPropertyUuid };
}
export function sessionContext(field: SessionContextField): SessionContextRef {
	return { kind: "session-context", field };
}
export function formField(uuid: Uuid): FormFieldRef {
	return { kind: "field", uuid };
}
export function tableColumn(
	tableId: LookupTableId,
	columnId: LookupColumnId,
): TableColumnTerm {
	return { kind: "table-column", tableId, columnId };
}
export function fixedLocation(locationUuid: Uuid): FixedLocationTerm {
	return { kind: "fixed-location", locationUuid };
}
export function ownerLocationAtLevel(
	levelUuid: Uuid,
	ownerCaseType: string,
): OwnerLocationAtLevelTerm {
	return { kind: "owner-location-at-level", levelUuid, ownerCaseType };
}
export function literal(value: string | number | boolean | null): Literal {
	return { kind: "literal", value };
}
export function qualifiedLiteral(
	value: string | number | boolean | null,
	data_type: CasePropertyDataType,
): Literal {
	return { kind: "literal", value, data_type };
}
export function dateLiteral(value: string): Literal {
	return qualifiedLiteral(value, "date");
}
export function datetimeLiteral(value: string): Literal {
	return qualifiedLiteral(value, "datetime");
}
export function timeLiteral(value: string): Literal {
	return qualifiedLiteral(value, "time");
}
export function relationStep(
	identifier: string,
	throughCaseType?: string,
): RelationStep {
	return throughCaseType === undefined
		? { identifier }
		: { identifier, throughCaseType };
}
export function selfPath(): Extract<RelationPath, { kind: "self" }> {
	return { kind: "self" };
}
export function ancestorPath(
	first: RelationStep,
	...rest: RelationStep[]
): Extract<RelationPath, { kind: "ancestor" }> {
	return { kind: "ancestor", via: [first, ...rest] };
}
export function subcasePath(
	identifier: string,
	ofCaseType?: string,
): Extract<RelationPath, { kind: "subcase" }> {
	return ofCaseType === undefined
		? { kind: "subcase", identifier }
		: { kind: "subcase", identifier, ofCaseType };
}
export function anyRelationPath(
	identifier: string,
	ofCaseType?: string,
): Extract<RelationPath, { kind: "any-relation" }> {
	return ofCaseType === undefined
		? { kind: "any-relation", identifier }
		: { kind: "any-relation", identifier, ofCaseType };
}
type ComparisonExpression<K extends ComparisonKind> = {
	kind: K;
	left: Expression;
	right: Expression;
};
const comparison =
	<K extends ComparisonKind>(kind: K) =>
	(
		left: Term | Expression,
		right: Term | Expression,
	): ComparisonExpression<K> => ({
		kind,
		left: toExpression(left),
		right: toExpression(right),
	});
export const eq = comparison("eq");
export const neq = comparison("neq");
export const gt = comparison("gt");
export const gte = comparison("gte");
export const lt = comparison("lt");
export const lte = comparison("lte");
export function isIn(
	left: Term | Expression,
	first: Literal | Choice,
	...rest: (Literal | Choice)[]
): Extract<Expression, { kind: "in" }> {
	return {
		kind: "in",
		left: toExpression(left),
		values: [first, ...rest],
	};
}
export function and(): Extract<Expression, { kind: "match-all" }>;
export function and<T extends Expression>(
	only: T,
): T extends import("./types").ConditionArm
	? T
	: Extract<Expression, { kind: "not" }>;
export function and(
	first: Expression,
	second: Expression,
	...rest: Expression[]
): Extract<Expression, { kind: "and" }>;
export function and(...clauses: Expression[]): Expression {
	const reduced = reduceAndImpl(clauses);
	if (reduced !== undefined) return reduced;
	return { kind: "and", clauses: clauses as [Expression, ...Expression[]] };
}
export function or(): Extract<Expression, { kind: "match-none" }>;
export function or<T extends Expression>(
	only: T,
): T extends import("./types").ConditionArm
	? T
	: Extract<Expression, { kind: "not" }>;
export function or(
	first: Expression,
	second: Expression,
	...rest: Expression[]
): Extract<Expression, { kind: "or" }>;
export function or(...clauses: Expression[]): Expression {
	const reduced = reduceOrImpl(clauses);
	if (reduced !== undefined) return reduced;
	return { kind: "or", clauses: clauses as [Expression, ...Expression[]] };
}
export function not(
	clause: Extract<Expression, { kind: "match-all" }>,
): Extract<Expression, { kind: "match-none" }>;
export function not(
	clause: Extract<Expression, { kind: "match-none" }>,
): Extract<Expression, { kind: "match-all" }>;
export function not(clause: Extract<Expression, { kind: "not" }>): Expression;
export function not(clause: Expression): Extract<Expression, { kind: "not" }>;
export function not(clause: Expression): Expression {
	const reduced = reduceNotImpl(clause);
	if (reduced !== undefined) return reduced;
	return { kind: "not", clause };
}
export function within(
	property: PropertyRef,
	center: Term | Expression,
	distance: number | Expression,
	unit: DistanceUnit | Expression,
): Extract<Expression, { kind: "within-distance" }> {
	return {
		kind: "within-distance",
		property,
		center: toExpression(center),
		distance,
		unit,
	};
}
export function match(
	property: PropertyRef | Expression,
	value: string | Term | Expression,
	mode: MatchMode,
): Extract<Expression, { kind: "match" }> {
	const wrapped =
		typeof value === "string"
			? toExpression(literal(value))
			: toExpression(value);
	return { kind: "match", property, value: wrapped, mode };
}
export function multiSelectAny(
	property: PropertyRef,
	first: Literal,
	...rest: Literal[]
): Extract<Expression, { kind: "multi-select-contains" }> {
	return {
		kind: "multi-select-contains",
		property,
		values: [first, ...rest],
		quantifier: "any",
	};
}
export function multiSelectAll(
	property: PropertyRef,
	first: Literal,
	...rest: Literal[]
): Extract<Expression, { kind: "multi-select-contains" }> {
	return {
		kind: "multi-select-contains",
		property,
		values: [first, ...rest],
		quantifier: "all",
	};
}
export function whenInput(
	inputRef: SearchInputRef,
	clause: Expression,
): Extract<Expression, { kind: "when-input-present" }> {
	return { kind: "when-input-present", input: inputRef, clause };
}
export function matchAll(): Extract<Expression, { kind: "match-all" }> {
	return { kind: "match-all" };
}
export function matchNone(): Extract<Expression, { kind: "match-none" }> {
	return { kind: "match-none" };
}
export function isMatchAll(
	p: Expression,
): p is Extract<Expression, { kind: "match-all" }> {
	return p.kind === "match-all";
}
export function isMatchNone(
	p: Expression,
): p is Extract<Expression, { kind: "match-none" }> {
	return p.kind === "match-none";
}
export function isBlank(
	left: Term | Expression,
): Extract<Expression, { kind: "is-blank" }> {
	return { kind: "is-blank", left: toExpression(left) };
}
export function matchesPattern(
	left: Term | Expression,
	pattern: string | Expression,
): Extract<Expression, { kind: "matches-pattern" }> {
	return { kind: "matches-pattern", left: toExpression(left), pattern };
}
type BetweenOptions = {
	lower?: Term | Expression;
	upper?: Term | Expression;
	lowerInclusive?: boolean;
	upperInclusive?: boolean;
};
export function between(
	left: Term | Expression,
	opts: BetweenOptions,
): Extract<Expression, { kind: "between" }> {
	const lowerInclusive = opts.lowerInclusive ?? true;
	const upperInclusive = opts.upperInclusive ?? true;
	const base = {
		kind: "between" as const,
		left: toExpression(left),
		lowerInclusive,
		upperInclusive,
	};
	if (opts.lower !== undefined && opts.upper !== undefined) {
		return {
			...base,
			lower: toExpression(opts.lower),
			upper: toExpression(opts.upper),
		};
	}
	if (opts.lower !== undefined) {
		return { ...base, lower: toExpression(opts.lower) };
	}
	if (opts.upper !== undefined) {
		return { ...base, upper: toExpression(opts.upper) };
	}
	return base;
}
export function exists(
	via: RelationPath,
	where?: Expression,
): Extract<Expression, { kind: "exists" }> {
	return where === undefined
		? { kind: "exists", via }
		: { kind: "exists", via, where };
}
export function missing(
	via: RelationPath,
	where?: Expression,
): Extract<Expression, { kind: "missing" }> {
	return where === undefined
		? { kind: "missing", via }
		: { kind: "missing", via, where };
}
export function term(t: Term): Extract<Expression, { kind: "term" }> {
	return { kind: "term", term: t };
}
export function today(): Extract<Expression, { kind: "today" }> {
	return { kind: "today" };
}
export function now(): Extract<Expression, { kind: "now" }> {
	return { kind: "now" };
}
/** What the worker typed into the entry's one case list's search box. */
export function caseListSearchText(): Extract<
	Expression,
	{ kind: "case-list-search-text" }
> {
	return { kind: "case-list-search-text" };
}
export function idOf(opUuid: Uuid): Extract<Expression, { kind: "id-of" }> {
	return { kind: "id-of", opUuid };
}
export function actingUser(): Extract<Expression, { kind: "acting-user" }> {
	return { kind: "acting-user" };
}
export function unowned(): Extract<Expression, { kind: "unowned" }> {
	return { kind: "unowned" };
}
export function tableLookup(
	tableId: LookupTableId,
	resultColumnId: LookupColumnId,
	where: Expression,
): Extract<Expression, { kind: "table-lookup" }> {
	return { kind: "table-lookup", tableId, resultColumnId, where };
}
export function dateAdd(
	date: Expression,
	interval: DateAddInterval,
	quantity: Expression,
): Extract<Expression, { kind: "date-add" }> {
	return { kind: "date-add", date, interval, quantity };
}
export function dateCoerce(
	value: Expression,
): Extract<Expression, { kind: "date-coerce" }> {
	return { kind: "date-coerce", value };
}
export function datetimeCoerce(
	value: Expression,
): Extract<Expression, { kind: "datetime-coerce" }> {
	return { kind: "datetime-coerce", value };
}
export function double(
	value: Expression,
): Extract<Expression, { kind: "double" }> {
	return { kind: "double", value };
}
export function arith(
	op: ArithOp,
	left: Expression,
	right: Expression,
): Extract<Expression, { kind: "arith" }> {
	return { kind: "arith", op, left, right };
}
export function concat(
	first: Expression,
	...rest: Expression[]
): Extract<Expression, { kind: "concat" }> {
	return { kind: "concat", parts: [first, ...rest] };
}
export function coalesce(
	first: Expression,
	...rest: Expression[]
): Extract<Expression, { kind: "coalesce" }> {
	return { kind: "coalesce", values: [first, ...rest] };
}
export function ifExpr(
	cond: Expression,
	thenBranch: Expression,
	elseBranch: Expression,
): Extract<Expression, { kind: "if" }> {
	return {
		kind: "if",
		cond,
		// biome-ignore lint/suspicious/noThenProperty: Persisted AST branch data is never callable.
		then: thenBranch,
		else: elseBranch,
	};
}
export function switchCase(
	when: Literal | Choice,
	thenValue: Expression,
): SwitchCase {
	return {
		when,
		// biome-ignore lint/suspicious/noThenProperty: Persisted AST branch data is never callable.
		then: thenValue,
	};
}
export function switchExpr(
	on: Expression,
	cases: [SwitchCase, ...SwitchCase[]],
	fallback: Expression,
): Extract<Expression, { kind: "switch" }> {
	return { kind: "switch", on, cases, fallback };
}
export function count(
	via: RelationPath | Expression,
	where?: Expression,
): Extract<Expression, { kind: "count" }> {
	return where === undefined
		? { kind: "count", via }
		: { kind: "count", via, where };
}
export function formatDate(
	date: Expression,
	pattern: FormatDatePreset | string | Expression,
): Extract<Expression, { kind: "format-date" }> {
	return { kind: "format-date", date, pattern };
}
