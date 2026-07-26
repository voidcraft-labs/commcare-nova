// lib/doc/hooks/useCaseOperations.ts
//
// One read/write surface over a form's case operations, shared by the
// centre-canvas list and the rail's per-operation body.
//
// It lives with the doc hooks rather than beside its screens because it
// reads the WHOLE document: every planner takes it, and the operation
// graph spans the form's fields (repeat scopes) as well as its
// operations. Selector-accepting store hooks are lib-private, so a
// surface that needs the whole doc gets a named hook here instead.
//
// Selection lives in the URL, not here. That is deliberate: a form can
// hold twenty operations, "look at this one" needs to be sendable, and
// a URL-held selection already survives a preview flip for free — the
// case workspace needed a controller above the preview boundary only
// because its selection was local state.
//
// Every legality question routes to the planners. This hook decides
// nothing; it asks, and hands the answer to the surface that has to
// explain it.

"use client";

import { useCallback, useMemo } from "react";
import { type CaseOperation, orderedCaseOperations } from "@/lib/domain";
import {
	addCaseOperationMutations,
	type CaseOperationEditVerdict,
	type CaseOperationMutationPlan,
	caseOperationEditVerdict,
	moveCaseOperationMutation,
	removeCaseOperationMutation,
	updateCaseOperationMutations,
} from "../caseOperationMutations";
import { caseOperationConditionalGuardUuids } from "../caseOperationOrder";
import {
	type CaseOperationDependency,
	type CaseOperationMoveVerdict,
	caseOperationDependencyOccurrences,
	caseOperationDependencyTargets,
	caseOperationMoveVerdicts,
} from "../caseOperationReview";
import type { Uuid } from "../types";
import { useBlueprintDoc } from "./useBlueprintDoc";
import {
	type CommitOutcome,
	useBlueprintMutations,
} from "./useBlueprintMutations";

export interface CaseOperationsView {
	/** Execution order — the order the runtime applies them. */
	readonly operations: readonly CaseOperation[];
	/** Per operation, the operations whose conditions it inherits. */
	readonly inheritedGuards: ReadonlyMap<Uuid, readonly Uuid[]>;
	/** Human name for a row, for a sentence or a refusal. */
	readonly nameOf: (uuid: Uuid) => string | undefined;
	/** Who consumes this operation, and through which slots. */
	readonly dependentsOf: (uuid: Uuid) => readonly CaseOperationDependency[];
	/** The creates this operation consumes, in execution order. */
	readonly dependenciesOf: (uuid: Uuid) => readonly Uuid[];
	/** The move planner's answer for every candidate position. */
	readonly moveVerdicts: (
		uuid: Uuid,
	) => ReadonlyMap<number, CaseOperationMoveVerdict>;
	/** Whether removal is allowed, and what blocks it. */
	readonly removalPlan: (uuid: Uuid) => CaseOperationMutationPlan;
	/** Whether one complete edited shape can pass the shared commit gate. */
	readonly editVerdict: (operation: CaseOperation) => CaseOperationEditVerdict;
	readonly add: (operation: CaseOperation, index?: number) => CommitOutcome;
	readonly update: (operation: CaseOperation) => CommitOutcome;
	readonly remove: (uuid: Uuid) => CommitOutcome | undefined;
	readonly move: (uuid: Uuid, index: number) => CommitOutcome | undefined;
}

export function useCaseOperations(formUuid: Uuid): CaseOperationsView {
	const mutations = useBlueprintMutations();
	/* The whole doc: every planner takes it, and the operation graph spans
	 * the form's fields (repeat scopes) as well as its operations. */
	const doc = useBlueprintDoc((state) => state);

	const operations = useMemo(
		() => orderedCaseOperations(doc.forms[formUuid] ?? {}),
		[doc, formUuid],
	);

	const inheritedGuards = useMemo(() => {
		const guards = caseOperationConditionalGuardUuids(doc, formUuid);
		const order = new Map(
			operations.map((operation, index) => [operation.uuid, index]),
		);
		const result = new Map<Uuid, readonly Uuid[]>();
		for (const operation of operations) {
			const inherited = [...(guards.get(operation.uuid) ?? [])]
				// An operation never guards itself, but be explicit rather than
				// trusting the analysis not to include it.
				.filter((uuid) => uuid !== operation.uuid)
				.sort(
					(left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0),
				);
			result.set(operation.uuid, inherited);
		}
		return result;
	}, [doc, formUuid, operations]);

	const nameOf = useCallback(
		(uuid: Uuid) => operations.find((operation) => operation.uuid === uuid)?.id,
		[operations],
	);

	const dependentsOf = useCallback(
		(uuid: Uuid) => {
			const form = doc.forms[formUuid];
			return form === undefined
				? []
				: caseOperationDependencyOccurrences(form, uuid);
		},
		[doc, formUuid],
	);

	const dependenciesOf = useCallback(
		(uuid: Uuid) => {
			const form = doc.forms[formUuid];
			return form === undefined
				? []
				: caseOperationDependencyTargets(form, uuid);
		},
		[doc, formUuid],
	);

	const moveVerdicts = useCallback(
		(uuid: Uuid) => caseOperationMoveVerdicts(doc, formUuid, uuid),
		[doc, formUuid],
	);

	const removalPlan = useCallback(
		(uuid: Uuid) => removeCaseOperationMutation(doc, formUuid, uuid),
		[doc, formUuid],
	);
	const editVerdict = useCallback(
		(operation: CaseOperation) =>
			caseOperationEditVerdict(doc, formUuid, operation),
		[doc, formUuid],
	);

	/* Inline, not toasting: a refusal belongs beside the list it is about,
	 * and these surfaces all have somewhere to put it. */
	const add = useCallback(
		(operation: CaseOperation, index?: number) =>
			mutations.inline.commitMany(
				addCaseOperationMutations(doc, formUuid, operation, index),
			),
		[doc, formUuid, mutations],
	);

	const update = useCallback(
		(operation: CaseOperation) =>
			mutations.inline.commitMany(
				updateCaseOperationMutations(doc, formUuid, operation),
			),
		[doc, formUuid, mutations],
	);

	const remove = useCallback(
		(uuid: Uuid) => {
			const plan = removeCaseOperationMutation(doc, formUuid, uuid);
			// A refused plan never reaches the store: the surface asked
			// `removalPlan` first and is showing the review instead.
			return plan.ok
				? mutations.inline.commitMany([...plan.mutations])
				: undefined;
		},
		[doc, formUuid, mutations],
	);

	const move = useCallback(
		(uuid: Uuid, index: number) => {
			const plan = moveCaseOperationMutation(doc, formUuid, uuid, index);
			return plan.ok
				? mutations.inline.commitMany([...plan.mutations])
				: undefined;
		},
		[doc, formUuid, mutations],
	);

	return {
		operations,
		inheritedGuards,
		nameOf,
		dependentsOf,
		dependenciesOf,
		moveVerdicts,
		removalPlan,
		editVerdict,
		add,
		update,
		remove,
		move,
	};
}
