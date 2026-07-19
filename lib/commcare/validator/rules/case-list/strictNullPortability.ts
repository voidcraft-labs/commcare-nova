/**
 * Rule: no module-level Predicate/ValueExpression slot emitted to CommCare may
 * use Nova's strict `is-null` semantics.
 *
 * Nova's Preview/Postgres evaluator can distinguish an absent property from a
 * property recorded as the empty string. CommCare's emitted case-list/search
 * expression dialects cannot: both states collapse to the portable
 * `property = ''` test. Emitting `is-null` there would therefore make Preview
 * and the exported app disagree.
 *
 * The slot inventory lives in `moduleWireSlots.ts`. The canonical
 * predicate/expression walkers cross predicates nested inside every
 * ValueExpression carrier, so an `is-null` hidden in an `if` condition cannot
 * bypass the rule. Strict-null collapses identically in the server-side CSQL
 * dialect, so advanced predicates get the same whole-tree judgment as
 * on-device predicate slots.
 */

import type { BlueprintDoc, Module, Uuid } from "@/lib/domain";
import {
	type Predicate,
	type ValueExpression,
	walkExpressionPredicateNodes,
	walkPredicateNodes,
} from "@/lib/domain/predicate";
import { type ValidationError, validationError } from "../../errors";
import {
	collectModuleWireSlotFindings,
	type ModuleWireSlotIdentity,
} from "./moduleWireSlots";

type StrictNullPredicate = Extract<Predicate, { kind: "is-null" }>;

export function strictNullPortability(
	mod: Module,
	moduleUuid: Uuid,
	_doc: BlueprintDoc,
): ValidationError[] {
	const judgePredicate = (
		predicate: Predicate,
		slot: ModuleWireSlotIdentity,
	): ValidationError | undefined => {
		const offender = firstStrictNull(predicate);
		return offender === undefined ? undefined : buildError(slot, offender);
	};

	return collectModuleWireSlotFindings(mod, moduleUuid, {
		calculatedColumns: "runtime",
		judgePredicate,
		judgeCsqlPredicate: judgePredicate,
		judgeExpression(expression, slot) {
			const offender = firstStrictNullInExpression(expression);
			return offender === undefined ? undefined : buildError(slot, offender);
		},
	});
}

function firstStrictNull(
	predicate: Predicate,
): StrictNullPredicate | undefined {
	let offender: StrictNullPredicate | undefined;
	walkPredicateNodes(predicate, (node) => {
		if (offender === undefined && node.kind === "is-null") offender = node;
	});
	return offender;
}

function firstStrictNullInExpression(
	expression: ValueExpression,
): StrictNullPredicate | undefined {
	let offender: StrictNullPredicate | undefined;
	walkExpressionPredicateNodes(expression, (node) => {
		if (offender === undefined && node.kind === "is-null") offender = node;
	});
	return offender;
}

function buildError(
	args: ModuleWireSlotIdentity,
	offender: StrictNullPredicate,
): ValidationError {
	const left = offender.left;
	const property =
		left.kind === "term" && left.term.kind === "prop"
			? left.term.property
			: undefined;
	return validationError(
		"CASE_LIST_STRICT_NULL_NOT_PORTABLE",
		"module",
		`Module "${args.mod.name}" uses a strict \`is-null\` condition${property ? ` on case property "${property}"` : ""} in ${args.slotLabel}, but CommCare treats a value that was never recorded and one recorded as blank as the same in this emitted expression. Use \`is-blank\` so Preview and the exported app agree.`,
		{ moduleUuid: args.moduleUuid, moduleName: args.mod.name },
		{
			slot: args.slot,
			surface: args.surface,
			...(property !== undefined ? { property } : {}),
			...(args.input !== undefined
				? {
						inputUuid: args.input.uuid,
						inputName: args.input.name,
						inputLabel: args.input.label,
					}
				: {}),
			...(args.column !== undefined
				? {
						columnUuid: args.column.uuid,
						columnLabel: args.column.label,
					}
				: {}),
		},
	);
}
