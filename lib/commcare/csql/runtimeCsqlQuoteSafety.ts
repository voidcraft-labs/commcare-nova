import { expressionChildren } from "@/lib/domain/expression/children";
import type { SearchInputDecl } from "@/lib/domain/expression/context";
import { isConditionArm } from "@/lib/domain/expression/types";
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
import type { Expression } from "@/lib/domain/expression/types";

/** Prompt bytes that can survive into one on-device-computed string result. */
export function collectRuntimeCsqlStringExpressionInputNames(
	expression: Expression,
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

/** Follow only on-device outputs that can preserve entered quote bytes. */
function collectOnDeviceOutputTaint(
	expression: Expression,
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
		default:
			if (isConditionArm(expression) || expression.kind === "negate") return;
			for (const child of expressionChildren(expression)) {
				if (child.kind === "expression")
					collectOnDeviceOutputTaint(child.value, names);
			}
	}
}
