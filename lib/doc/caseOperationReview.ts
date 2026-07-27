// lib/doc/caseOperationReview.ts
//
// What an author must be told BEFORE a reorder or a removal, derived
// entirely from the planners in `caseOperationMutations.ts` and the
// order analysis in `caseOperationOrder.ts`. Nothing here decides
// legality — it only asks, and then names what the answer was about.
//
// Three projections:
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
//   - `caseOperationRemovalBlockers` asks the REMOVE planner what stops
//     a removal, and only then enriches each blocker with its slots.
//     The order matters: the planner refuses on `id-of` edges AND on
//     target-type transitions, so a surface that listed the `id-of`
//     walk instead would render an empty list under a heading saying
//     removal is blocked. A blocker with no slots is a type blocker,
//     and says so by carrying none rather than by being absent.
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
	type CaseOperationDependencyKind,
	moveCaseOperationMutation,
	removeCaseOperationMutation,
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
			readonly reason: "dependent-reference";
			/** Which constraint refused — the copy for the two is different,
			 *  and neither sentence is true of the other. */
			readonly dependencyKind: CaseOperationDependencyKind;
			/** The operations the refusal is about, in execution order. */
			readonly blockingUuids: readonly Uuid[];
	  }
	| {
			readonly ok: false;
			readonly reason: "operation-not-found" | "execution-order";
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
		const blockingUuids = plan.ok
			? []
			: inExecutionOrder(ordered, plan.dependentUuids);
		verdicts.set(
			index,
			plan.ok
				? { ok: true }
				: plan.reason === "dependent-reference"
					? {
							ok: false,
							reason: plan.reason,
							dependencyKind: plan.dependencyKind,
							blockingUuids,
						}
					: { ok: false, reason: plan.reason, blockingUuids },
		);
	}
	return verdicts;
}

/**
 * What stops this operation being removed, straight from the remove
 * planner, with each blocker's `id-of` slots when it has any.
 *
 * Asking the planner rather than walking `id-of` edges is the whole
 * point. Removal is refused by two different constraints — a consumer
 * holding a reference, and a later operation whose target type this
 * operation establishes — and only the first has slots to name. Walking
 * references would silently drop every blocker of the second kind, which
 * on a surface that has already decided removal is blocked means a
 * heading with nothing under it.
 *
 * An empty slot list is therefore meaningful, not missing data: it says
 * this operation blocks for a type reason, and the copy names it without
 * inventing a slot.
 */
export function caseOperationRemovalBlockers(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): readonly CaseOperationDependency[] {
	const form = doc.forms[formUuid];
	if (form === undefined) return [];
	const plan = removeCaseOperationMutation(doc, formUuid, uuid);
	if (plan.ok) return [];
	const slotsByUuid = new Map(
		caseOperationDependencyOccurrences(form, uuid).map((dependency) => [
			dependency.operationUuid,
			dependency.slots,
		]),
	);
	const ordered = orderedCaseOperations(form);
	return inExecutionOrder(ordered, plan.dependentUuids).map(
		(operationUuid) => ({
			operationUuid,
			slots: slotsByUuid.get(operationUuid) ?? [],
		}),
	);
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
