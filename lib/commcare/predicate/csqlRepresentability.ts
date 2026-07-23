/**
 * Static representability contract for predicates emitted as CCHQ CSQL.
 *
 * CSQL resembles XPath, but its server parser is deliberately much narrower:
 * ordinary comparisons require a case-property `Step` on the left and reject
 * a property `Step` anywhere on the right. The one alternate left-hand shape
 * is `subcase-count(...)`. Values that depend only on literals, search/session
 * data, and pure expressions can be evaluated by the on-device `concat(...)`
 * wrapper and inserted as the right-hand scalar. Values that read case data
 * cannot: the remote-request screen has no current case context, and CCHQ must
 * evaluate those reads per Elasticsearch result instead.
 *
 * This module is the single typed model of that boundary. The validator uses
 * {@link checkCsqlRepresentability} for friendly authoring errors; the emitter
 * uses {@link normalizeCsqlPredicate} to canonicalize the valid reversible
 * case where the sole query anchor was authored on the right.
 */

import { resolveCommCareDatePattern } from "@/lib/domain/dateFormats";
import type {
	ComparisonKind,
	Literal,
	Predicate,
	ValueExpression,
} from "@/lib/domain/predicate";
import { unhandledKindMessage } from "@/lib/domain/predicate";
import { isNativeCsqlValueExpression } from "../expression/csqlEmitter";
import {
	classifyCalendarDateAddQuantity,
	classifySubcaseCountBound,
} from "./runtimeCsqlNumericSafety";
import { isCsqlStringLiteralRepresentable } from "./stringQuoting";

export type CsqlRepresentabilityReason =
	| "comparison-needs-case-property"
	| "case-property-on-value-side"
	| "related-count-on-value-side"
	| "unsupported-related-count"
	| "strict-null-not-portable"
	| "self-relation-not-queryable"
	| "case-query-in-runtime-value"
	| "csql-string-not-quotable"
	| "calendar-date-add-needs-whole-number"
	| "subcase-count-needs-nonnegative-whole-number"
	| "multiple-property-scopes"
	| "form-context-value-not-csql";

type RuntimeValueDialect = "csql" | "on-device";

export interface CsqlRepresentabilityIssue {
	readonly reason: CsqlRepresentabilityReason;
	readonly path: readonly (string | number)[];
	readonly message: string;
}

const SWAPPED_COMPARISON_KIND: Readonly<
	Record<ComparisonKind, ComparisonKind>
> = {
	eq: "eq",
	neq: "neq",
	gt: "lt",
	gte: "lte",
	lt: "gt",
	lte: "gte",
};

/** Return every CSQL boundary violation without changing the authored AST. */
export function checkCsqlRepresentability(
	predicate: Predicate,
): readonly CsqlRepresentabilityIssue[] {
	const issues: CsqlRepresentabilityIssue[] = [];
	checkQueryPredicate(predicate, [], issues);
	return issues;
}

/**
 * Put a query anchor authored on the right onto CCHQ's required left side.
 *
 * `2 < prop(age)` becomes `prop(age) > 2`; equality/inequality simply swap.
 * The same normalization applies to a direct `subcase-count(...)` anchor.
 * Property-via lifting runs after this pass, so a related property authored on
 * the right is canonicalized before its relation becomes an exists envelope.
 */
export function normalizeCsqlPredicate(predicate: Predicate): Predicate {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return predicate;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte": {
			const left = normalizeExpression(predicate.left);
			const right = normalizeExpression(predicate.right);
			if (!isQueryAnchor(left) && isQueryAnchor(right)) {
				return {
					kind: SWAPPED_COMPARISON_KIND[predicate.kind],
					left: right,
					right: left,
				};
			}
			return { kind: predicate.kind, left, right };
		}
		case "in":
			return {
				...predicate,
				left: normalizeExpression(predicate.left),
			};
		case "between":
			return {
				...predicate,
				left: normalizeExpression(predicate.left),
				...(predicate.lower !== undefined
					? { lower: normalizeExpression(predicate.lower) }
					: {}),
				...(predicate.upper !== undefined
					? { upper: normalizeExpression(predicate.upper) }
					: {}),
			};
		case "is-null":
		case "is-blank":
			return {
				kind: predicate.kind,
				left: normalizeExpression(predicate.left),
			};
		case "match":
			return {
				...predicate,
				value: normalizeExpression(predicate.value),
			};
		case "within-distance":
			return {
				...predicate,
				center: normalizeExpression(predicate.center),
			};
		case "multi-select-contains":
			return predicate;
		case "and":
		case "or":
			return {
				kind: predicate.kind,
				clauses: predicate.clauses.map(normalizeCsqlPredicate) as [
					Predicate,
					...Predicate[],
				],
			};
		case "not":
			return {
				kind: "not",
				clause: normalizeCsqlPredicate(predicate.clause),
			};
		case "when-input-present":
			return {
				...predicate,
				clause: normalizeCsqlPredicate(predicate.clause),
			};
		case "exists":
		case "missing":
			return {
				kind: predicate.kind,
				via: predicate.via,
				...(predicate.where !== undefined
					? { where: normalizeCsqlPredicate(predicate.where) }
					: {}),
			};
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				unhandledKindMessage({
					where: "normalizeCsqlPredicate",
					family: "Predicate",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"match-all",
						"match-none",
						"eq",
						"neq",
						"gt",
						"gte",
						"lt",
						"lte",
						"in",
						"between",
						"is-null",
						"is-blank",
						"match",
						"within-distance",
						"multi-select-contains",
						"and",
						"or",
						"not",
						"when-input-present",
						"exists",
						"missing",
					],
				}),
			);
		}
	}
}

function normalizeExpression(expression: ValueExpression): ValueExpression {
	switch (expression.kind) {
		case "term":
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return expression;
		case "date-add":
			return {
				...expression,
				date: normalizeExpression(expression.date),
				quantity: normalizeExpression(expression.quantity),
			};
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			return {
				kind: expression.kind,
				value: normalizeExpression(expression.value),
			};
		case "arith":
			return {
				...expression,
				left: normalizeExpression(expression.left),
				right: normalizeExpression(expression.right),
			};
		case "concat":
			return {
				kind: "concat",
				parts: expression.parts.map(normalizeExpression) as [
					ValueExpression,
					...ValueExpression[],
				],
			};
		case "coalesce":
			return {
				kind: "coalesce",
				values: expression.values.map(normalizeExpression) as [
					ValueExpression,
					...ValueExpression[],
				],
			};
		case "if":
			return {
				kind: "if",
				cond: normalizeCsqlPredicate(expression.cond),
				// biome-ignore lint/suspicious/noThenProperty: mirrors the typed ValueExpression AST; the value is never callable.
				then: normalizeExpression(expression.then),
				else: normalizeExpression(expression.else),
			};
		case "switch":
			return {
				kind: "switch",
				on: normalizeExpression(expression.on),
				cases: expression.cases.map((entry) => ({
					when: entry.when,
					// biome-ignore lint/suspicious/noThenProperty: mirrors the typed SwitchCase AST; the value is never callable.
					then: normalizeExpression(entry.then),
				})) as typeof expression.cases,
				fallback: normalizeExpression(expression.fallback),
			};
		case "count":
			return {
				kind: "count",
				via: expression.via,
				...(expression.where !== undefined
					? { where: normalizeCsqlPredicate(expression.where) }
					: {}),
			};
		case "format-date":
			return {
				...expression,
				date: normalizeExpression(expression.date),
			};
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				unhandledKindMessage({
					where: "normalizeCsqlExpression",
					family: "ValueExpression",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"term",
						"today",
						"now",
						"id-of",
						"acting-user",
						"unowned",
						"date-add",
						"date-coerce",
						"datetime-coerce",
						"double",
						"arith",
						"concat",
						"coalesce",
						"if",
						"switch",
						"count",
						"unwrap-list",
						"format-date",
					],
				}),
			);
		}
	}
}

function checkQueryPredicate(
	predicate: Predicate,
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
): void {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte": {
			if (hasMultiplePropertyScopes([predicate.left, predicate.right])) {
				issues.push({
					reason: "multiple-property-scopes",
					path,
					message:
						"This search compares properties from different cases. Choose one property and compare it with a value, or make separate related-case conditions.",
				});
				return;
			}
			const leftAnchor = isQueryAnchor(predicate.left);
			const rightAnchor = isQueryAnchor(predicate.right);
			if (leftAnchor) {
				checkQueryAnchor(predicate.left, [...path, "left"], issues);
				if (isSubcaseCountQueryAnchor(predicate.left)) {
					checkSubcaseCountBound(predicate.right, [...path, "right"], issues);
				} else {
					checkRuntimeValue(
						predicate.right,
						[...path, "right"],
						issues,
						"csql",
					);
				}
				return;
			}
			if (rightAnchor) {
				// The emitter reverses the comparison before CSQL parsing.
				checkQueryAnchor(predicate.right, [...path, "right"], issues);
				if (isSubcaseCountQueryAnchor(predicate.right)) {
					checkSubcaseCountBound(predicate.left, [...path, "left"], issues);
				} else {
					checkRuntimeValue(predicate.left, [...path, "left"], issues, "csql");
				}
				return;
			}
			checkQueryAnchor(predicate.left, [...path, "left"], issues);
			return;
		}
		case "in":
			checkQueryAnchor(predicate.left, [...path, "left"], issues);
			for (let index = 0; index < predicate.values.length; index += 1) {
				const valuePath = [...path, "values", index] as const;
				if (isSubcaseCountQueryAnchor(predicate.left)) {
					checkSubcaseCountBound(
						{
							kind: "term",
							term: {
								kind: "literal",
								value: predicate.values[index].value,
							},
						},
						valuePath,
						issues,
					);
				} else {
					checkCsqlLiteral(predicate.values[index].value, valuePath, issues);
				}
			}
			return;
		case "between": {
			const scopeExpressions = [
				predicate.left,
				...(predicate.lower === undefined ? [] : [predicate.lower]),
				...(predicate.upper === undefined ? [] : [predicate.upper]),
			];
			if (hasMultiplePropertyScopes(scopeExpressions)) {
				issues.push({
					reason: "multiple-property-scopes",
					path,
					message:
						"This range compares properties from different cases. Choose one property and give it fixed or entered bounds, or make separate related-case conditions.",
				});
				return;
			}
			checkQueryAnchor(predicate.left, [...path, "left"], issues);
			if (predicate.lower !== undefined) {
				if (isSubcaseCountQueryAnchor(predicate.left)) {
					checkSubcaseCountBound(predicate.lower, [...path, "lower"], issues);
				} else {
					checkRuntimeValue(
						predicate.lower,
						[...path, "lower"],
						issues,
						"csql",
					);
				}
			}
			if (predicate.upper !== undefined) {
				if (isSubcaseCountQueryAnchor(predicate.left)) {
					checkSubcaseCountBound(predicate.upper, [...path, "upper"], issues);
				} else {
					checkRuntimeValue(
						predicate.upper,
						[...path, "upper"],
						issues,
						"csql",
					);
				}
			}
			return;
		}
		case "is-null":
			issues.push({
				reason: "strict-null-not-portable",
				path,
				message:
					"Search treats a value that was never recorded the same as a blank value. Use 'is blank' here.",
			});
			checkPropertyOnlyLeft(predicate.left, [...path, "left"], issues);
			return;
		case "is-blank":
			checkPropertyOnlyLeft(predicate.left, [...path, "left"], issues);
			return;
		case "match":
			checkRuntimeValue(predicate.value, [...path, "value"], issues, "csql");
			return;
		case "within-distance":
			checkRuntimeValue(predicate.center, [...path, "center"], issues, "csql");
			return;
		case "multi-select-contains":
			for (let index = 0; index < predicate.values.length; index += 1) {
				checkCsqlLiteral(
					predicate.values[index].value,
					[...path, "values", index],
					issues,
				);
			}
			return;
		case "and":
		case "or":
			for (let index = 0; index < predicate.clauses.length; index += 1) {
				checkQueryPredicate(
					predicate.clauses[index],
					[...path, predicate.kind, index],
					issues,
				);
			}
			return;
		case "not":
			checkQueryPredicate(predicate.clause, [...path, "not", "clause"], issues);
			return;
		case "when-input-present":
			checkQueryPredicate(
				predicate.clause,
				[...path, "when-input-present", "clause"],
				issues,
			);
			return;
		case "exists":
		case "missing":
			if (predicate.via.kind === "self") {
				issues.push({
					reason: "self-relation-not-queryable",
					path: [...path, predicate.kind, "via"],
					message:
						"Choose a parent or child relationship for this related-case condition. 'This case' does not point to a related case.",
				});
			}
			if (predicate.where !== undefined) {
				checkQueryPredicate(
					predicate.where,
					[...path, predicate.kind, "where"],
					issues,
				);
			}
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				unhandledKindMessage({
					where: "checkCsqlRepresentability",
					family: "Predicate",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"match-all",
						"match-none",
						"eq",
						"neq",
						"gt",
						"gte",
						"lt",
						"lte",
						"in",
						"between",
						"is-null",
						"is-blank",
						"match",
						"within-distance",
						"multi-select-contains",
						"and",
						"or",
						"not",
						"when-input-present",
						"exists",
						"missing",
					],
				}),
			);
		}
	}
}

function checkPropertyOnlyLeft(
	expression: ValueExpression,
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
): void {
	if (isPropertyExpression(expression)) return;
	issues.push({
		reason: "comparison-needs-case-property",
		path,
		message:
			"Choose a case property as the field to search. Use inputs and calculations only for the value.",
	});
}

function checkQueryAnchor(
	expression: ValueExpression,
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
): void {
	if (isPropertyExpression(expression)) return;
	if (expression.kind === "count") {
		if (expression.via.kind !== "subcase") {
			issues.push({
				reason: "unsupported-related-count",
				path,
				message:
					"This search can count child cases, but not parent cases or relationships in either direction. Choose a child relationship.",
			});
			return;
		}
		if (expression.where !== undefined) {
			checkQueryPredicate(
				expression.where,
				[...path, "count", "where"],
				issues,
			);
		}
		return;
	}
	issues.push({
		reason: "comparison-needs-case-property",
		path,
		message:
			"Choose one case property as the field to search, then compare it with a fixed, entered, or calculated value.",
	});
}

function checkSubcaseCountBound(
	expression: ValueExpression,
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
): void {
	if (classifySubcaseCountBound(expression).kind === "unsupported") {
		issues.push({
			reason: "subcase-count-needs-nonnegative-whole-number",
			path,
			message:
				"Compare the child-case count with a whole number that is zero or greater. Use a fixed number or convert one search answer to Number.",
		});
	}
	// Keep the ordinary runtime-value walk as defense in depth: a rejected
	// computed bound may also contain a candidate-case property, which cannot be
	// evaluated while Core is constructing the remote query.
	checkRuntimeValue(expression, path, issues, "csql");
}

function checkRuntimeValue(
	expression: ValueExpression,
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
	dialect: RuntimeValueDialect,
): void {
	const nativeCsql =
		dialect === "csql" && isNativeCsqlValueExpression(expression);
	if (
		dialect === "csql" &&
		!nativeCsql &&
		hasReachableStaticallyUnquotableOutput(expression)
	) {
		pushUnquotableCsqlStringIssue(path, issues);
	}
	const childDialect: RuntimeValueDialect = nativeCsql ? "csql" : "on-device";

	switch (expression.kind) {
		case "term":
			if (expression.term.kind === "prop") {
				issues.push({
					reason: "case-property-on-value-side",
					path,
					message:
						"This search compares two case properties. Choose one property and compare it with a fixed value, a search answer, or a user detail instead.",
				});
			} else if (expression.term.kind === "field") {
				issues.push({
					reason: "form-context-value-not-csql",
					path,
					message:
						"A form-field value is available during form submission, not while the remote case-search query runs.",
				});
			} else if (dialect === "csql" && expression.term.kind === "literal") {
				checkCsqlLiteral(expression.term.value, path, issues);
			}
			return;
		case "today":
		case "now":
			return;
		case "id-of":
		case "acting-user":
		case "unowned":
			issues.push({
				reason: "form-context-value-not-csql",
				path,
				message:
					expression.kind === "id-of"
						? "A case-operation id is available during form submission, not while the remote case-search query runs."
						: "An operation owner identity is available during form submission, not while the remote case-search query runs.",
			});
			return;
		case "date-add":
			if (
				dialect === "csql" &&
				(expression.interval === "months" || expression.interval === "years") &&
				classifyCalendarDateAddQuantity(expression.quantity).kind ===
					"unsupported"
			) {
				issues.push({
					reason: "calendar-date-add-needs-whole-number",
					path: [...path, "quantity"],
					message:
						"Month and year shifts need a whole number. Use a fixed whole number or convert one search answer to Number; use days or weeks for fractional durations.",
				});
			}
			checkRuntimeValue(
				expression.date,
				[...path, "date"],
				issues,
				childDialect,
			);
			checkRuntimeValue(
				expression.quantity,
				[...path, "quantity"],
				issues,
				childDialect,
			);
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			checkRuntimeValue(
				expression.value,
				[...path, "value"],
				issues,
				childDialect,
			);
			return;
		case "arith":
			checkRuntimeValue(
				expression.left,
				[...path, "left"],
				issues,
				"on-device",
			);
			checkRuntimeValue(
				expression.right,
				[...path, "right"],
				issues,
				"on-device",
			);
			return;
		case "concat":
			for (let index = 0; index < expression.parts.length; index += 1) {
				checkRuntimeValue(
					expression.parts[index],
					[...path, "parts", index],
					issues,
					"on-device",
				);
			}
			return;
		case "coalesce":
			for (let index = 0; index < expression.values.length; index += 1) {
				checkRuntimeValue(
					expression.values[index],
					[...path, "values", index],
					issues,
					"on-device",
				);
			}
			return;
		case "if":
			checkRuntimePredicate(expression.cond, [...path, "if", "cond"], issues);
			checkRuntimeValue(
				expression.then,
				[...path, "if", "then"],
				issues,
				"on-device",
			);
			checkRuntimeValue(
				expression.else,
				[...path, "if", "else"],
				issues,
				"on-device",
			);
			return;
		case "switch":
			checkRuntimeValue(
				expression.on,
				[...path, "switch", "on"],
				issues,
				"on-device",
			);
			for (let index = 0; index < expression.cases.length; index += 1) {
				checkRuntimeValue(
					expression.cases[index].then,
					[...path, "switch", "cases", index, "then"],
					issues,
					"on-device",
				);
			}
			checkRuntimeValue(
				expression.fallback,
				[...path, "switch", "fallback"],
				issues,
				"on-device",
			);
			return;
		case "count":
			issues.push({
				reason: "related-count-on-value-side",
				path,
				message:
					"Put the child-case count on the left side of the condition, then compare it with a fixed or entered whole number.",
			});
			if (expression.where !== undefined) {
				checkQueryPredicate(
					expression.where,
					[...path, "count", "where"],
					issues,
				);
			}
			return;
		case "format-date":
			checkRuntimeValue(
				expression.date,
				[...path, "date"],
				issues,
				"on-device",
			);
			return;
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				unhandledKindMessage({
					where: "checkCsqlRuntimeValue",
					family: "ValueExpression",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"term",
						"today",
						"now",
						"id-of",
						"acting-user",
						"unowned",
						"date-add",
						"date-coerce",
						"datetime-coerce",
						"double",
						"arith",
						"concat",
						"coalesce",
						"if",
						"switch",
						"count",
						"unwrap-list",
						"format-date",
					],
				}),
			);
		}
	}
}

function checkCsqlLiteral(
	value: unknown,
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
): void {
	if (typeof value !== "string" || isCsqlStringLiteralRepresentable(value)) {
		return;
	}
	pushUnquotableCsqlStringIssue(path, issues);
}

function pushUnquotableCsqlStringIssue(
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
): void {
	issues.push({
		reason: "csql-string-not-quotable",
		path,
		message:
			"This value uses both single and double quotation marks. Rewrite it to use only one kind.",
	});
}

/**
 * Conservatively evaluate the small subset of on-device expressions whose
 * string output is guaranteed at authoring time. Most non-native expressions
 * are protected by the runtime quote guard because their value depends on the
 * device session. Pure literal concatenation/coalescing and a statically chosen
 * branch are different: Nova already knows they will hit the unrepresentable
 * CSQL value, so waiting for runtime would turn an authoring error into a
 * failed search.
 */
function staticallyKnownOnDeviceString(
	expression: ValueExpression,
): string | undefined {
	switch (expression.kind) {
		case "term":
			return expression.term.kind === "literal" &&
				typeof expression.term.value === "string"
				? expression.term.value
				: undefined;
		case "concat": {
			const parts = expression.parts.map(staticallyKnownOnDeviceString);
			return parts.every((part): part is string => part !== undefined)
				? parts.join("")
				: undefined;
		}
		case "coalesce": {
			const values = expression.values.map(staticallyKnownOnDeviceString);
			if (values.some((value) => value === undefined)) return undefined;
			return (values as string[]).find((value) => value.length > 0) ?? "";
		}
		case "if":
			if (staticallyKnownPredicateBoolean(expression.cond) === true) {
				return staticallyKnownOnDeviceString(expression.then);
			}
			if (staticallyKnownPredicateBoolean(expression.cond) === false) {
				return staticallyKnownOnDeviceString(expression.else);
			}
			return agreedStaticString([
				staticallyKnownOnDeviceString(expression.then),
				staticallyKnownOnDeviceString(expression.else),
			]);
		case "switch": {
			const selected = staticallySelectedSwitchBranch(expression);
			if (selected !== undefined) {
				return staticallyKnownOnDeviceString(selected);
			}
			return agreedStaticString([
				...expression.cases.map((entry) =>
					staticallyKnownOnDeviceString(entry.then),
				),
				staticallyKnownOnDeviceString(expression.fallback),
			]);
		}
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "date-add":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "arith":
		case "count":
		case "unwrap-list":
		case "format-date":
			return undefined;
		default: {
			const _exhaustive: never = expression;
			throw new Error(`Unhandled ValueExpression ${String(_exhaustive)}`);
		}
	}
}

/**
 * Whether an on-device expression has any author-known reachable output that
 * necessarily contains both CSQL quote delimiters. Dynamic bytes remain the
 * runtime guard's responsibility, but a fixed bad branch is still an invalid
 * authored state even when a condition decides whether that branch runs.
 */
function hasReachableStaticallyUnquotableOutput(
	expression: ValueExpression,
): boolean {
	const exact = staticallyKnownOnDeviceString(expression);
	if (exact !== undefined && !isCsqlStringLiteralRepresentable(exact)) {
		return true;
	}

	switch (expression.kind) {
		case "concat": {
			if (expression.parts.some(hasReachableStaticallyUnquotableOutput)) {
				return true;
			}
			const guaranteed = expression.parts.reduce<QuoteGuarantee>(
				(acc, part) => {
					const child = guaranteedQuoteKinds(part);
					return {
						single: acc.single || child.single,
						double: acc.double || child.double,
					};
				},
				{ single: false, double: false },
			);
			return guaranteed.single && guaranteed.double;
		}
		case "coalesce":
			for (const value of expression.values) {
				if (hasReachableStaticallyUnquotableOutput(value)) return true;
				if (isGuaranteedNonemptyString(value)) return false;
			}
			return false;
		case "if":
			if (staticallyKnownPredicateBoolean(expression.cond) === true) {
				return hasReachableStaticallyUnquotableOutput(expression.then);
			}
			if (staticallyKnownPredicateBoolean(expression.cond) === false) {
				return hasReachableStaticallyUnquotableOutput(expression.else);
			}
			return (
				hasReachableStaticallyUnquotableOutput(expression.then) ||
				hasReachableStaticallyUnquotableOutput(expression.else)
			);
		case "switch": {
			const selected = staticallySelectedSwitchBranch(expression);
			if (selected !== undefined) {
				return hasReachableStaticallyUnquotableOutput(selected);
			}
			return (
				expression.cases.some((entry) =>
					hasReachableStaticallyUnquotableOutput(entry.then),
				) || hasReachableStaticallyUnquotableOutput(expression.fallback)
			);
		}
		case "format-date":
			return !isCsqlStringLiteralRepresentable(
				resolveCommCareDatePattern(expression.pattern),
			);
		case "term":
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "date-add":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "arith":
		case "count":
		case "unwrap-list":
			return false;
		default: {
			const _exhaustive: never = expression;
			return _exhaustive;
		}
	}
}

/** Whether every evaluation returns a non-empty string. */
function isGuaranteedNonemptyString(expression: ValueExpression): boolean {
	const known = staticallyKnownOnDeviceString(expression);
	if (known !== undefined) return known.length > 0;

	switch (expression.kind) {
		case "concat":
			return expression.parts.some(isGuaranteedNonemptyString);
		case "coalesce":
			return expression.values.some(isGuaranteedNonemptyString);
		case "if":
			if (staticallyKnownPredicateBoolean(expression.cond) === true) {
				return isGuaranteedNonemptyString(expression.then);
			}
			if (staticallyKnownPredicateBoolean(expression.cond) === false) {
				return isGuaranteedNonemptyString(expression.else);
			}
			return (
				isGuaranteedNonemptyString(expression.then) &&
				isGuaranteedNonemptyString(expression.else)
			);
		case "switch": {
			const selected = staticallySelectedSwitchBranch(expression);
			if (selected !== undefined) {
				return isGuaranteedNonemptyString(selected);
			}
			return (
				expression.cases.every((entry) =>
					isGuaranteedNonemptyString(entry.then),
				) && isGuaranteedNonemptyString(expression.fallback)
			);
		}
		case "format-date":
			return (
				isGuaranteedTemporalValue(expression.date) &&
				resolveCommCareDatePattern(expression.pattern).length > 0
			);
		case "term":
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "date-add":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "arith":
		case "count":
		case "unwrap-list":
			return false;
		default: {
			const _exhaustive: never = expression;
			return _exhaustive;
		}
	}
}

interface QuoteGuarantee {
	readonly single: boolean;
	readonly double: boolean;
}

/** Quote kinds present in every possible string output of an expression. */
function guaranteedQuoteKinds(expression: ValueExpression): QuoteGuarantee {
	const known = staticallyKnownOnDeviceString(expression);
	if (known !== undefined) {
		return { single: known.includes("'"), double: known.includes('"') };
	}
	switch (expression.kind) {
		case "concat":
			return expression.parts.reduce<QuoteGuarantee>(
				(acc, part) => {
					const child = guaranteedQuoteKinds(part);
					return {
						single: acc.single || child.single,
						double: acc.double || child.double,
					};
				},
				{ single: false, double: false },
			);
		case "coalesce": {
			const reachable: QuoteGuarantee[] = [];
			for (const value of expression.values) {
				if (staticallyKnownOnDeviceString(value) === "") continue;
				reachable.push(guaranteedQuoteKinds(value));
				if (isGuaranteedNonemptyString(value)) break;
			}
			return intersectQuoteGuarantees(reachable);
		}
		case "if": {
			const knownCondition = staticallyKnownPredicateBoolean(expression.cond);
			if (knownCondition === true) return guaranteedQuoteKinds(expression.then);
			if (knownCondition === false)
				return guaranteedQuoteKinds(expression.else);
			return intersectQuoteGuarantees([
				guaranteedQuoteKinds(expression.then),
				guaranteedQuoteKinds(expression.else),
			]);
		}
		case "switch": {
			const selected = staticallySelectedSwitchBranch(expression);
			if (selected !== undefined) return guaranteedQuoteKinds(selected);
			return intersectQuoteGuarantees([
				...expression.cases.map((entry) => guaranteedQuoteKinds(entry.then)),
				guaranteedQuoteKinds(expression.fallback),
			]);
		}
		case "format-date": {
			if (!isGuaranteedTemporalValue(expression.date)) {
				return { single: false, double: false };
			}
			const pattern = resolveCommCareDatePattern(expression.pattern);
			return {
				single: pattern.includes("'"),
				double: pattern.includes('"'),
			};
		}
		default:
			return { single: false, double: false };
	}
}

function intersectQuoteGuarantees(
	guarantees: readonly QuoteGuarantee[],
): QuoteGuarantee {
	if (guarantees.length === 0) return { single: false, double: false };
	return {
		single: guarantees.every((guarantee) => guarantee.single),
		double: guarantees.every((guarantee) => guarantee.double),
	};
}

interface StaticallyKnownPrimitive {
	readonly value: Literal["value"];
}

function staticallyKnownPrimitive(
	expression: ValueExpression,
): StaticallyKnownPrimitive | undefined {
	if (expression.kind === "term" && expression.term.kind === "literal") {
		return { value: expression.term.value };
	}
	const stringValue = staticallyKnownOnDeviceString(expression);
	return stringValue === undefined ? undefined : { value: stringValue };
}

function staticPrimitiveEqual(
	left: Literal["value"],
	right: Literal["value"],
): boolean {
	return typeof left === typeof right && left === right;
}

/** Resolve only predicates whose result is independent of case/session data. */
function staticallyKnownPredicateBoolean(
	predicate: Predicate,
): boolean | undefined {
	switch (predicate.kind) {
		case "match-all":
			return true;
		case "match-none":
			return false;
		case "eq":
		case "neq": {
			const left = staticallyKnownPrimitive(predicate.left);
			const right = staticallyKnownPrimitive(predicate.right);
			if (left === undefined || right === undefined) return undefined;
			const equal = staticPrimitiveEqual(left.value, right.value);
			return predicate.kind === "eq" ? equal : !equal;
		}
		case "and": {
			let hasUnknown = false;
			for (const clause of predicate.clauses) {
				const result = staticallyKnownPredicateBoolean(clause);
				if (result === false) return false;
				if (result === undefined) hasUnknown = true;
			}
			return hasUnknown ? undefined : true;
		}
		case "or": {
			let hasUnknown = false;
			for (const clause of predicate.clauses) {
				const result = staticallyKnownPredicateBoolean(clause);
				if (result === true) return true;
				if (result === undefined) hasUnknown = true;
			}
			return hasUnknown ? undefined : false;
		}
		case "not": {
			const result = staticallyKnownPredicateBoolean(predicate.clause);
			return result === undefined ? undefined : !result;
		}
		case "is-null": {
			const value = staticallyKnownPrimitive(predicate.left);
			return value === undefined ? undefined : value.value === null;
		}
		case "is-blank": {
			const value = staticallyKnownPrimitive(predicate.left);
			return value === undefined
				? undefined
				: value.value === null || value.value === "";
		}
		case "gt":
		case "gte":
		case "lt":
		case "lte":
		case "in":
		case "between":
		case "match":
		case "multi-select-contains":
		case "within-distance":
		case "when-input-present":
		case "exists":
		case "missing":
			return undefined;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(`Unhandled Predicate ${String(_exhaustive)}`);
		}
	}
}

function staticallySelectedSwitchBranch(
	expression: Extract<ValueExpression, { kind: "switch" }>,
): ValueExpression | undefined {
	const discriminator = staticallyKnownPrimitive(expression.on);
	if (discriminator === undefined) return undefined;
	const selected = expression.cases.find((entry) =>
		staticPrimitiveEqual(discriminator.value, entry.when.value),
	);
	return selected?.then ?? expression.fallback;
}

/** Whether a value is guaranteed to evaluate to a real temporal scalar. */
function isGuaranteedTemporalValue(expression: ValueExpression): boolean {
	switch (expression.kind) {
		case "today":
		case "now":
			return true;
		case "term":
			return (
				expression.term.kind === "literal" &&
				typeof expression.term.value === "string" &&
				(expression.term.data_type === "date" ||
					expression.term.data_type === "datetime") &&
				expression.term.value.length > 0
			);
		case "date-add":
			return isGuaranteedTemporalValue(expression.date);
		case "date-coerce":
		case "datetime-coerce":
			return isGuaranteedTemporalValue(expression.value);
		case "if": {
			const condition = staticallyKnownPredicateBoolean(expression.cond);
			if (condition === true) return isGuaranteedTemporalValue(expression.then);
			if (condition === false)
				return isGuaranteedTemporalValue(expression.else);
			return (
				isGuaranteedTemporalValue(expression.then) &&
				isGuaranteedTemporalValue(expression.else)
			);
		}
		case "switch": {
			const selected = staticallySelectedSwitchBranch(expression);
			if (selected !== undefined) return isGuaranteedTemporalValue(selected);
			return (
				expression.cases.every((entry) =>
					isGuaranteedTemporalValue(entry.then),
				) && isGuaranteedTemporalValue(expression.fallback)
			);
		}
		case "coalesce":
			return expression.values.some(isGuaranteedTemporalValue);
		case "double":
		case "arith":
		case "concat":
		case "count":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "unwrap-list":
		case "format-date":
			return false;
		default: {
			const _exhaustive: never = expression;
			return _exhaustive;
		}
	}
}

function agreedStaticString(
	values: readonly (string | undefined)[],
): string | undefined {
	if (values.length === 0 || values.some((value) => value === undefined)) {
		return undefined;
	}
	const first = values[0] as string;
	return values.every((value) => value === first) ? first : undefined;
}

/** Predicates inside a runtime-only `if` value cannot read case rows. */
function checkRuntimePredicate(
	predicate: Predicate,
	path: readonly (string | number)[],
	issues: CsqlRepresentabilityIssue[],
): void {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			checkRuntimeValue(predicate.left, [...path, "left"], issues, "on-device");
			checkRuntimeValue(
				predicate.right,
				[...path, "right"],
				issues,
				"on-device",
			);
			return;
		case "in":
			checkRuntimeValue(predicate.left, [...path, "left"], issues, "on-device");
			return;
		case "between":
			checkRuntimeValue(predicate.left, [...path, "left"], issues, "on-device");
			if (predicate.lower !== undefined) {
				checkRuntimeValue(
					predicate.lower,
					[...path, "lower"],
					issues,
					"on-device",
				);
			}
			if (predicate.upper !== undefined) {
				checkRuntimeValue(
					predicate.upper,
					[...path, "upper"],
					issues,
					"on-device",
				);
			}
			return;
		case "is-null":
			issues.push({
				reason: "strict-null-not-portable",
				path,
				message:
					"Search treats a value that was never recorded the same as a blank value. Use 'is blank' here.",
			});
			checkRuntimeValue(predicate.left, [...path, "left"], issues, "on-device");
			return;
		case "is-blank":
			checkRuntimeValue(predicate.left, [...path, "left"], issues, "on-device");
			return;
		case "and":
		case "or":
			for (let index = 0; index < predicate.clauses.length; index += 1) {
				checkRuntimePredicate(
					predicate.clauses[index],
					[...path, predicate.kind, index],
					issues,
				);
			}
			return;
		case "not":
			checkRuntimePredicate(
				predicate.clause,
				[...path, "not", "clause"],
				issues,
			);
			return;
		case "when-input-present":
			checkRuntimePredicate(
				predicate.clause,
				[...path, "when-input-present", "clause"],
				issues,
			);
			return;
		case "match":
		case "multi-select-contains":
		case "within-distance":
		case "exists":
		case "missing":
			issues.push({
				reason: "case-query-in-runtime-value",
				path,
				message:
					"This calculation needs a case row before search results exist. Move the case condition out of the calculation and into the surrounding rule.",
			});
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				unhandledKindMessage({
					where: "checkCsqlRuntimePredicate",
					family: "Predicate",
					received: (_exhaustive as { kind?: unknown })?.kind ?? _exhaustive,
					knownKinds: [
						"match-all",
						"match-none",
						"eq",
						"neq",
						"gt",
						"gte",
						"lt",
						"lte",
						"in",
						"between",
						"is-null",
						"is-blank",
						"and",
						"or",
						"not",
						"when-input-present",
						"match",
						"multi-select-contains",
						"within-distance",
						"exists",
						"missing",
					],
				}),
			);
		}
	}
}

function isPropertyExpression(expression: ValueExpression): boolean {
	return expression.kind === "term" && expression.term.kind === "prop";
}

function isSubcaseCountQueryAnchor(expression: ValueExpression): boolean {
	return expression.kind === "count" && expression.via.kind === "subcase";
}

function isQueryAnchor(expression: ValueExpression): boolean {
	return (
		isPropertyExpression(expression) || isSubcaseCountQueryAnchor(expression)
	);
}

/**
 * Detect one operator whose operands require candidate values from different
 * case rows. Relation-property normalization cannot make that scalar
 * comparison faithful: wrapping one read in `exists` changes the other read's
 * scope, while nesting two envelopes lets two unrelated rows satisfy each
 * half. CSQL also forbids a property Step on the value side.
 */
function hasMultiplePropertyScopes(
	expressions: readonly ValueExpression[],
): boolean {
	const scopes = new Set<string>();
	for (const expression of expressions) {
		collectPropertyScopesFromExpression(expression, scopes);
		if (scopes.size > 1) return true;
	}
	return false;
}

function collectPropertyScopesFromExpression(
	expression: ValueExpression,
	out: Set<string>,
): void {
	switch (expression.kind) {
		case "term":
			if (expression.term.kind === "prop") {
				const via = expression.term.via;
				out.add(
					via === undefined || via.kind === "self"
						? `self:${expression.term.caseType}`
						: `via:${JSON.stringify(via)}`,
				);
			}
			return;
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return;
		case "date-add":
			collectPropertyScopesFromExpression(expression.date, out);
			collectPropertyScopesFromExpression(expression.quantity, out);
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "unwrap-list":
			collectPropertyScopesFromExpression(expression.value, out);
			return;
		case "arith":
			collectPropertyScopesFromExpression(expression.left, out);
			collectPropertyScopesFromExpression(expression.right, out);
			return;
		case "concat":
			for (const part of expression.parts) {
				collectPropertyScopesFromExpression(part, out);
			}
			return;
		case "coalesce":
			for (const value of expression.values) {
				collectPropertyScopesFromExpression(value, out);
			}
			return;
		case "if":
			collectPropertyScopesFromPredicate(expression.cond, out);
			collectPropertyScopesFromExpression(expression.then, out);
			collectPropertyScopesFromExpression(expression.else, out);
			return;
		case "switch":
			collectPropertyScopesFromExpression(expression.on, out);
			for (const entry of expression.cases) {
				collectPropertyScopesFromExpression(entry.then, out);
			}
			collectPropertyScopesFromExpression(expression.fallback, out);
			return;
		case "count":
			if (expression.where !== undefined) {
				collectPropertyScopesFromPredicate(expression.where, out);
			}
			return;
		case "format-date":
			collectPropertyScopesFromExpression(expression.date, out);
			return;
		default: {
			const _exhaustive: never = expression;
			throw new Error(`Unhandled ValueExpression ${String(_exhaustive)}`);
		}
	}
}

function collectPropertyScopesFromPredicate(
	predicate: Predicate,
	out: Set<string>,
): void {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			collectPropertyScopesFromExpression(predicate.left, out);
			collectPropertyScopesFromExpression(predicate.right, out);
			return;
		case "in":
		case "is-null":
		case "is-blank":
			collectPropertyScopesFromExpression(predicate.left, out);
			return;
		case "between":
			collectPropertyScopesFromExpression(predicate.left, out);
			if (predicate.lower !== undefined)
				collectPropertyScopesFromExpression(predicate.lower, out);
			if (predicate.upper !== undefined)
				collectPropertyScopesFromExpression(predicate.upper, out);
			return;
		case "match":
			collectPropertyScopesFromExpression(
				{ kind: "term", term: predicate.property },
				out,
			);
			collectPropertyScopesFromExpression(predicate.value, out);
			return;
		case "multi-select-contains":
			collectPropertyScopesFromExpression(
				{ kind: "term", term: predicate.property },
				out,
			);
			return;
		case "within-distance":
			collectPropertyScopesFromExpression(
				{ kind: "term", term: predicate.property },
				out,
			);
			collectPropertyScopesFromExpression(predicate.center, out);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses) {
				collectPropertyScopesFromPredicate(clause, out);
			}
			return;
		case "not":
			collectPropertyScopesFromPredicate(predicate.clause, out);
			return;
		case "when-input-present":
			collectPropertyScopesFromPredicate(predicate.clause, out);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined) {
				collectPropertyScopesFromPredicate(predicate.where, out);
			}
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(`Unhandled Predicate ${String(_exhaustive)}`);
		}
	}
}
