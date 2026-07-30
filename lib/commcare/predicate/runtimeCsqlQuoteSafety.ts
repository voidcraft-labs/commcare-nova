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

import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import type { Uuid } from "@/lib/domain/uuid";
import { isNativeCsqlValueExpression } from "../expression/csqlEmitter";
import { normalizeCsqlPredicate } from "./csqlRepresentability";

type OperandPosition = "comparison-operand" | "value";

/**
 * Collect prompt identities whose raw runtime value is quoted into emitted CSQL
 * query. Reversible comparison normalization runs first so a subcase-count
 * authored on the RHS is treated as the native LHS anchor the emitter creates.
 */
export function collectRuntimeCsqlStringInputUuids(
	predicate: Predicate | undefined,
): ReadonlySet<Uuid> {
	const inputUuids = new Set<Uuid>();
	if (predicate !== undefined) {
		collectPredicateRuntimeStringInputs(
			normalizeCsqlPredicate(predicate),
			inputUuids,
		);
	}
	return inputUuids;
}

/** Prompt bytes that can survive into one on-device-computed string result. */
export function collectRuntimeCsqlStringExpressionInputUuids(
	expression: ValueExpression,
): ReadonlySet<Uuid> {
	const inputUuids = new Set<Uuid>();
	collectOnDeviceOutputTaint(expression, inputUuids);
	return inputUuids;
}

function collectPredicateRuntimeStringInputs(
	predicate: Predicate,
	inputUuids: Set<Uuid>,
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
				inputUuids,
			);
			collectServerOperandRuntimeStringInputs(
				predicate.right,
				"value",
				inputUuids,
			);
			return;
		case "in":
		case "is-null":
		case "is-blank":
			collectServerOperandRuntimeStringInputs(
				predicate.left,
				"comparison-operand",
				inputUuids,
			);
			return;
		case "between":
			collectServerOperandRuntimeStringInputs(
				predicate.left,
				"comparison-operand",
				inputUuids,
			);
			if (predicate.lower !== undefined) {
				collectServerOperandRuntimeStringInputs(
					predicate.lower,
					"value",
					inputUuids,
				);
			}
			if (predicate.upper !== undefined) {
				collectServerOperandRuntimeStringInputs(
					predicate.upper,
					"value",
					inputUuids,
				);
			}
			return;
		case "match":
			collectServerOperandRuntimeStringInputs(
				predicate.value,
				"value",
				inputUuids,
			);
			return;
		case "within-distance":
			collectServerOperandRuntimeStringInputs(
				predicate.center,
				"value",
				inputUuids,
			);
			return;
		case "and":
		case "or":
			for (const clause of predicate.clauses) {
				collectPredicateRuntimeStringInputs(clause, inputUuids);
			}
			return;
		case "not":
			collectPredicateRuntimeStringInputs(predicate.clause, inputUuids);
			return;
		case "when-input-present":
			// The trigger contributes only `count(input)` to the wrapper. Its
			// bytes decide whether the clause runs but never enter CSQL.
			collectPredicateRuntimeStringInputs(predicate.clause, inputUuids);
			return;
		case "exists":
		case "missing":
			if (predicate.where !== undefined) {
				collectPredicateRuntimeStringInputs(predicate.where, inputUuids);
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
	inputUuids: Set<Uuid>,
): void {
	if (expression.kind === "count") {
		if (
			position === "comparison-operand" &&
			expression.via.kind === "subcase" &&
			expression.where !== undefined
		) {
			collectPredicateRuntimeStringInputs(expression.where, inputUuids);
		}
		// Every non-native count becomes an on-device number. Input bytes
		// may influence that number without appearing in its quoted output.
		return;
	}

	if (!isNativeCsqlValueExpression(expression)) {
		collectOnDeviceOutputTaint(expression, inputUuids);
		return;
	}

	switch (expression.kind) {
		case "term":
			if (expression.term.kind === "input") {
				inputUuids.add(expression.term.searchInputUuid);
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
		case "unwrap-list":
			collectServerOperandRuntimeStringInputs(
				expression.value,
				"value",
				inputUuids,
			);
			return;
		case "date-add":
			collectServerOperandRuntimeStringInputs(
				expression.date,
				"value",
				inputUuids,
			);
			collectServerOperandRuntimeStringInputs(
				expression.quantity,
				"value",
				inputUuids,
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
	inputUuids: Set<Uuid>,
): void {
	switch (expression.kind) {
		case "term":
			if (expression.term.kind === "input") {
				inputUuids.add(expression.term.searchInputUuid);
			}
			return;
		case "concat":
			for (const part of expression.parts) {
				collectOnDeviceOutputTaint(part, inputUuids);
			}
			return;
		case "coalesce":
			for (const value of expression.values) {
				collectOnDeviceOutputTaint(value, inputUuids);
			}
			return;
		case "if":
			collectOnDeviceOutputTaint(expression.then, inputUuids);
			collectOnDeviceOutputTaint(expression.else, inputUuids);
			return;
		case "switch":
			for (const entry of expression.cases) {
				collectOnDeviceOutputTaint(entry.then, inputUuids);
			}
			collectOnDeviceOutputTaint(expression.fallback, inputUuids);
			return;
		case "unwrap-list":
			collectOnDeviceOutputTaint(expression.value, inputUuids);
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
			// Lookup-result bytes do not originate in a search input. The
			// dormant-carrier compatibility rule rejects this expression before
			// CSQL emission.
			return;
		default: {
			const _exhaustive: never = expression;
			throw new Error(
				`collectRuntimeCsqlStringInputNames: unhandled on-device ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}
