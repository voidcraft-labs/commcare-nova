/**
 * Data-flow analysis for runtime search-input strings that become quoted CSQL
 * values.
 *
 * This mirrors the CSQL emitter's dialect boundary. Server-native terms and
 * value-function arguments insert runtime values into CSQL string literals.
 * Non-native expressions run in JavaRosa first; only branches whose output can
 * preserve the original input bytes taint the final quoted value. Trigger-only
 * and numeric/temporal/control uses are deliberately excluded so the runtime
 * does not reject user input that never enters the CSQL grammar.
 */

import type { Uuid } from "@/lib/domain";
import type {
	Predicate,
	SearchInputDecl,
	ValueExpression,
} from "@/lib/domain/predicate";
import { isNativeCsqlValueExpression } from "../expression/csqlCapabilities";
import { normalizeCsqlPredicate } from "./csqlRepresentability";

type OperandPosition = "comparison-operand" | "value";

/**
 * Collect prompt names whose raw runtime value is quoted into the emitted CSQL
 * query. Reversible comparison normalization runs first so a subcase-count
 * authored on the RHS is treated as the native LHS anchor the emitter creates.
 */
export function collectRuntimeCsqlStringInputNames(
	predicate: Predicate | undefined,
	knownInputs: readonly SearchInputDecl[] = [],
): ReadonlySet<string> {
	const uuids = new Set<Uuid>();
	if (predicate !== undefined) {
		collectPredicateRuntimeStringInputs(
			normalizeCsqlPredicate(predicate),
			uuids,
		);
	}
	return resolveInputNames(uuids, knownInputs);
}

/** Prompt bytes that can survive into one on-device-computed string result. */
export function collectRuntimeCsqlStringExpressionInputNames(
	expression: ValueExpression,
	knownInputs: readonly SearchInputDecl[] = [],
): ReadonlySet<string> {
	const uuids = new Set<Uuid>();
	collectOnDeviceOutputTaint(expression, uuids);
	return resolveInputNames(uuids, knownInputs);
}

function resolveInputNames(
	uuids: ReadonlySet<Uuid>,
	knownInputs: readonly SearchInputDecl[],
): ReadonlySet<string> {
	const names = new Set<string>();
	for (const uuid of uuids) {
		const name = knownInputs.find((input) => input.uuid === uuid)?.name;
		if (name !== undefined) names.add(name);
	}
	return names;
}

function collectPredicateRuntimeStringInputs(
	predicate: Predicate,
	names: Set<Uuid>,
): void {
	switch (predicate.kind) {
		case "match-all":
		case "match-none":
		case "multi-select-contains":
			return;
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			collectServerOperandRuntimeStringInputs(
				predicate.left,
				"comparison-operand",
				names,
			);
			collectServerOperandRuntimeStringInputs(predicate.right, "value", names);
			return;
		case "in":
		case "is-blank":
		case "matches-pattern":
			collectServerOperandRuntimeStringInputs(
				predicate.left,
				"comparison-operand",
				names,
			);
			return;
		case "between":
			collectServerOperandRuntimeStringInputs(
				predicate.left,
				"comparison-operand",
				names,
			);
			if (predicate.lower !== undefined) {
				collectServerOperandRuntimeStringInputs(
					predicate.lower,
					"value",
					names,
				);
			}
			if (predicate.upper !== undefined) {
				collectServerOperandRuntimeStringInputs(
					predicate.upper,
					"value",
					names,
				);
			}
			return;
		case "match":
			collectServerOperandRuntimeStringInputs(predicate.value, "value", names);
			return;
		case "within-distance":
			collectServerOperandRuntimeStringInputs(predicate.center, "value", names);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses) {
				collectPredicateRuntimeStringInputs(clause, names);
			}
			return;
		case "not":
			collectPredicateRuntimeStringInputs(predicate.clause, names);
			return;
		case "when-input-present":
			// The trigger contributes only `count(input)` to the wrapper. Its
			// bytes decide whether the clause runs but never enter CSQL.
			collectPredicateRuntimeStringInputs(predicate.clause, names);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined) {
				collectPredicateRuntimeStringInputs(predicate.where, names);
			}
			return;
		default: {
			const _exhaustive: never = predicate;
			throw new Error(
				`collectRuntimeCsqlStringInputNames: unhandled Predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

function collectServerOperandRuntimeStringInputs(
	expression: ValueExpression,
	position: OperandPosition,
	names: Set<Uuid>,
): void {
	if (expression.kind === "count") {
		if (
			position === "comparison-operand" &&
			expression.via.kind === "subcase" &&
			expression.where !== undefined
		) {
			collectPredicateRuntimeStringInputs(expression.where, names);
		}
		// Every non-native count becomes an on-device number. Input bytes
		// may influence that number without appearing in its quoted output.
		return;
	}

	if (!isNativeCsqlValueExpression(expression)) {
		collectOnDeviceOutputTaint(expression, names);
		return;
	}

	switch (expression.kind) {
		case "term":
			if (expression.term.kind === "input") {
				names.add(expression.term.searchInputUuid);
			}
			return;
		case "today":
		case "now":
		case "id-of":
		case "acting-user":
		case "unowned":
			return;
		case "date-coerce":
		case "datetime-coerce":
		case "double":
			collectServerOperandRuntimeStringInputs(expression.value, "value", names);
			return;
		case "date-add":
			collectServerOperandRuntimeStringInputs(expression.date, "value", names);
			collectServerOperandRuntimeStringInputs(
				expression.quantity,
				"value",
				names,
			);
			return;
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "format-date":
		case "table-lookup":
			throw new Error(
				`collectRuntimeCsqlStringInputNames: non-native expression '${expression.kind}' reached the native CSQL branch`,
			);
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				`collectRuntimeCsqlStringInputNames: unhandled ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}

/** Follow only on-device outputs that can preserve entered quote bytes. */
function collectOnDeviceOutputTaint(
	expression: ValueExpression,
	names: Set<Uuid>,
): void {
	switch (expression.kind) {
		case "term":
			if (expression.term.kind === "input") {
				names.add(expression.term.searchInputUuid);
			}
			return;
		case "concat":
			for (const part of expression.parts) {
				collectOnDeviceOutputTaint(part, names);
			}
			return;
		case "coalesce":
			for (const value of expression.values) {
				collectOnDeviceOutputTaint(value, names);
			}
			return;
		case "if":
			collectOnDeviceOutputTaint(expression.then, names);
			collectOnDeviceOutputTaint(expression.else, names);
			return;
		case "switch":
			for (const entry of expression.cases) {
				collectOnDeviceOutputTaint(entry.then, names);
			}
			collectOnDeviceOutputTaint(expression.fallback, names);
			return;
		case "today":
		case "now":
		case "date-add":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "arith":
		case "count":
		case "format-date":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "table-lookup":
			// Lookup-result bytes do not originate in a search input.
			return;
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				`collectRuntimeCsqlStringInputNames: unhandled on-device ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}
