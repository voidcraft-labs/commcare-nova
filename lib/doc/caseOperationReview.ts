// lib/doc/caseOperationReview.ts
//
// What an author must be told BEFORE a reorder or a removal, derived
// entirely from the planners in `caseOperationMutations.ts` and the
// order analysis in `caseOperationOrder.ts`. Nothing here decides
// legality — it only asks, and then names what the answer was about.
//
// Two projections:
//
//   - `caseOperationMoveVerdicts` asks the move planner about EVERY
//     candidate position at once. Keyboard reorder is adjacent and could
//     have asked about two, but a pointer drag is not: the analysis
//     refuses dependency inversion, target-type-transition inversion,
//     possible-runtime-alias inversion, and multiplicity-scope
//     inversion, so a drag can land on a refused position while both
//     of its neighbours are fine. One map answers both gestures, which
//     is what keeps them from disagreeing.
//
//   - `caseOperationDependencyOccurrences` names the SLOT through which
//     a consumer holds its reference. `caseOperationDependencyUuids`
//     collapses to a set, and on a twenty-operation form "Update client
//     uses it" is not actionable while "in the value of status" is.
//     Its per-slot walk mirrors that function's structure exactly, and
//     `__tests__/caseOperationReview.test.ts` asserts the two agree on
//     every operation shape so they cannot drift apart.

import type { BlueprintDoc } from "@/lib/domain";
import {
	type CaseOperation,
	type Form,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";
import {
	type Predicate,
	type ValueExpression,
	walkExpressionNodes,
	walkPredicateExpressionNodes,
} from "@/lib/domain/predicate";
import {
	type CaseOperationMutationPlan,
	moveCaseOperationMutation,
} from "./caseOperationMutations";
import { caseOperationDependencyUuids } from "./caseOperationOrder";

/**
 * How an operation is named in a sentence about it. Returns `undefined`
 * for an operation the caller cannot resolve — a refusal still has to
 * read as a sentence, so the copy layer supplies its own fallback rather
 * than printing a uuid.
 */
export type CaseOperationReviewName = (uuid: Uuid) => string | undefined;

/** Which slot of a consuming operation holds the reference. */
export type CaseOperationReferenceSlot =
	| { readonly kind: "target" }
	| { readonly kind: "link"; readonly identifier: string }
	| { readonly kind: "name" }
	| { readonly kind: "owner" }
	| { readonly kind: "rename" }
	| { readonly kind: "condition" }
	| { readonly kind: "write"; readonly property: string }
	| { readonly kind: "write-condition"; readonly property: string };

export interface CaseOperationDependency {
	/** The operation doing the consuming. */
	readonly operationUuid: Uuid;
	/** Every slot of that operation holding the reference, in slot order. */
	readonly slots: readonly CaseOperationReferenceSlot[];
}

/**
 * Every operation that references `uuid`, with the slots that do.
 *
 * Order follows execution order, so a review list reads in the same
 * sequence as the surface the author is looking at.
 */
export function caseOperationDependencyOccurrences(
	form: Form,
	uuid: Uuid,
): readonly CaseOperationDependency[] {
	const dependencies: CaseOperationDependency[] = [];
	for (const operation of orderedCaseOperations(form)) {
		if (operation.uuid === uuid) continue;
		const slots = referenceSlots(operation, uuid);
		if (slots.length > 0) {
			dependencies.push({ operationUuid: operation.uuid, slots });
		}
	}
	return dependencies;
}

/**
 * Mirrors `caseOperationDependencyUuids`' traversal, slot by slot. Any
 * new referencing slot must be added to BOTH; the parity test fails
 * otherwise.
 */
function referenceSlots(
	operation: CaseOperation,
	uuid: Uuid,
): CaseOperationReferenceSlot[] {
	const slots: CaseOperationReferenceSlot[] = [];
	if (
		(operation.target.kind === "op" && operation.target.opUuid === uuid) ||
		(operation.target.kind === "expression" &&
			expressionReferences(operation.target.expr, uuid))
	) {
		slots.push({ kind: "target" });
	}
	for (const link of operation.links ?? []) {
		const target = link.target;
		if (target === null) continue;
		if (
			(target.kind === "op" && target.opUuid === uuid) ||
			(target.kind === "expression" && expressionReferences(target.expr, uuid))
		) {
			slots.push({ kind: "link", identifier: link.identifier });
		}
	}
	for (const [kind, expression] of [
		["name", operation.name],
		["owner", operation.owner],
		["rename", operation.rename],
	] as const) {
		if (expression !== undefined && expressionReferences(expression, uuid)) {
			slots.push({ kind });
		}
	}
	for (const write of operation.writes ?? []) {
		if (expressionReferences(write.value, uuid)) {
			slots.push({ kind: "write", property: write.property });
		}
		if (
			write.condition !== undefined &&
			predicateReferences(write.condition, uuid)
		) {
			slots.push({ kind: "write-condition", property: write.property });
		}
	}
	if (
		operation.condition !== undefined &&
		predicateReferences(operation.condition, uuid)
	) {
		slots.push({ kind: "condition" });
	}
	return slots;
}

function expressionReferences(
	expression: ValueExpression,
	uuid: Uuid,
): boolean {
	let found = false;
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "id-of" && node.opUuid === uuid) found = true;
	});
	return found;
}

function predicateReferences(predicate: Predicate, uuid: Uuid): boolean {
	let found = false;
	walkPredicateExpressionNodes(predicate, (node) => {
		if (node.kind === "id-of" && node.opUuid === uuid) found = true;
	});
	return found;
}

/**
 * The creates this operation consumes, in execution order.
 *
 * The inverse of `caseOperationDependencyOccurrences`, and the other half
 * of what a refusal needs to read correctly. `dependencyOrderViolations`
 * answers with the operations whose REFERENCES would break, which
 * includes the moved operation itself whenever a consumer is dragged
 * ahead of what it consumes — so a refusal about that move has to name
 * what the moved operation depends on, not the operation itself.
 *
 * Reads the planner's own `caseOperationDependencyUuids` rather than
 * walking the operation again, so the two cannot disagree about what a
 * dependency is.
 */
export function caseOperationDependencyTargets(
	form: Form,
	uuid: Uuid,
): readonly Uuid[] {
	const ordered = orderedCaseOperations(form);
	const operation = ordered.find((candidate) => candidate.uuid === uuid);
	if (operation === undefined) return [];
	return inExecutionOrder(ordered, [
		...caseOperationDependencyUuids(operation),
	]);
}

export type CaseOperationMoveVerdict =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: Extract<
				CaseOperationMutationPlan,
				{ ok: false }
			>["reason"];
			/** The operations the refusal is about, in execution order. */
			readonly blockingUuids: readonly Uuid[];
	  };

/**
 * The move planner's answer for every candidate position, keyed by
 * destination index. The operation's own index is present and `ok` — a
 * move to where it already is changes nothing.
 *
 * Pure, so a drag computes this ONCE on drag start and reads it per
 * pointer move rather than re-planning twenty times a second.
 */
export function caseOperationMoveVerdicts(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): ReadonlyMap<number, CaseOperationMoveVerdict> {
	const form = doc.forms[formUuid];
	const verdicts = new Map<number, CaseOperationMoveVerdict>();
	if (form === undefined) return verdicts;
	const ordered = orderedCaseOperations(form);
	const currentIndex = ordered.findIndex(
		(operation) => operation.uuid === uuid,
	);
	if (currentIndex < 0) return verdicts;
	for (let index = 0; index < ordered.length; index++) {
		if (index === currentIndex) {
			verdicts.set(index, { ok: true });
			continue;
		}
		const plan = moveCaseOperationMutation(doc, formUuid, uuid, index);
		verdicts.set(
			index,
			plan.ok
				? { ok: true }
				: {
						ok: false,
						reason: plan.reason,
						blockingUuids: inExecutionOrder(ordered, plan.dependentUuids),
					},
		);
	}
	return verdicts;
}

function inExecutionOrder(
	ordered: readonly CaseOperation[],
	uuids: readonly Uuid[],
): readonly Uuid[] {
	const wanted = new Set(uuids);
	return ordered
		.filter((operation) => wanted.has(operation.uuid))
		.map((operation) => operation.uuid);
}
