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
	caseOperationAddVerdict,
	caseOperationAuthoringVerdict,
	caseOperationEditVerdict,
	moveCaseOperationMutation,
	planCaseOperationUpdate,
	removeCaseOperationMutation,
} from "../caseOperationMutations";
import { caseOperationConditionalGuardUuids } from "../caseOperationOrder";
import {
	type CaseOperationDependency,
	type CaseOperationMoveVerdict,
	caseOperationDependencyTargets,
	caseOperationMoveVerdicts,
	caseOperationRemovalBlockers,
} from "../caseOperationReview";
import type { Uuid } from "../types";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";
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
	/** What blocks removing this operation, and through which slots — the
	 *  remove planner's own answer, so a type blocker is listed too. */
	readonly removalBlockers: (uuid: Uuid) => readonly CaseOperationDependency[];
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
	/** Whether one complete insertion can pass the shared commit gate. */
	readonly addVerdict: (
		operation: CaseOperation,
		index?: number,
	) => CaseOperationEditVerdict;
	/** Whether this operation's full author shape is available on all editors.
	 * Moving is separate and remains available for a read-only carrier. */
	readonly authoringVerdict: (uuid: Uuid) => CaseOperationEditVerdict;
	readonly add: (operation: CaseOperation, index?: number) => CommitOutcome;
	readonly update: (operation: CaseOperation) => CommitOutcome;
	readonly remove: (uuid: Uuid) => CommitOutcome | undefined;
	readonly move: (
		uuid: Uuid,
		index: number,
	) => CaseOperationMoveCommitOutcome | undefined;
}

export type CaseOperationMoveCommitOutcome =
	| { readonly ok: true; readonly index: number; readonly total: number }
	| { readonly ok: false; readonly messages: string[] };

function refused(message: string): CommitOutcome {
	return { ok: false, messages: [message] };
}

export function useCaseOperations(formUuid: Uuid): CaseOperationsView {
	const mutations = useBlueprintMutations();
	const docApi = useBlueprintDocApi();
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

	const removalBlockers = useCallback(
		(uuid: Uuid) => caseOperationRemovalBlockers(doc, formUuid, uuid),
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
	const addVerdict = useCallback(
		(operation: CaseOperation, index?: number) =>
			caseOperationAddVerdict(doc, formUuid, operation, index),
		[doc, formUuid],
	);
	const authoringVerdict = useCallback(
		(uuid: Uuid): CaseOperationEditVerdict => {
			const operation = operations.find((candidate) => candidate.uuid === uuid);
			return operation === undefined
				? {
						ok: false,
						reason: "This case change is no longer part of the form.",
					}
				: caseOperationAuthoringVerdict(operation);
		},
		[operations],
	);

	/* Inline, not toasting: a refusal belongs beside the list it is about,
	 * and these surfaces all have somewhere to put it. */
	const add = useCallback(
		(operation: CaseOperation, index?: number) => {
			const fresh = docApi.getState();
			const form = fresh.forms[formUuid];
			if (form === undefined) {
				return refused("This form is no longer part of the app.");
			}
			if (
				(form.caseOperations ?? []).some(
					(candidate) => candidate.uuid === operation.uuid,
				)
			) {
				return refused(
					"This case change was added elsewhere first. Review the latest list and try again.",
				);
			}
			return mutations.inline.commitMany(
				addCaseOperationMutations(fresh, formUuid, operation, index),
			);
		},
		[docApi, formUuid, mutations],
	);

	const update = useCallback(
		(operation: CaseOperation) => {
			const base = doc.forms[formUuid]?.caseOperations?.find(
				(candidate) => candidate.uuid === operation.uuid,
			);
			if (base === undefined) {
				return refused("This case change is no longer part of the form.");
			}
			const fresh = docApi.getState();
			const plan = planCaseOperationUpdate(fresh, formUuid, operation, base);
			if (!plan.ok) return refused(plan.reason);
			return mutations.inline.commitMany([...plan.mutations]);
		},
		[doc, docApi, formUuid, mutations],
	);

	const remove = useCallback(
		(uuid: Uuid) => {
			const plan = removeCaseOperationMutation(
				docApi.getState(),
				formUuid,
				uuid,
			);
			// A refused plan never reaches the store: the surface asked
			// `removalPlan` first and is showing the review instead.
			return plan.ok
				? mutations.inline.commitMany([...plan.mutations])
				: undefined;
		},
		[docApi, formUuid, mutations],
	);

	const move = useCallback(
		(uuid: Uuid, index: number) => {
			const plan = moveCaseOperationMutation(
				docApi.getState(),
				formUuid,
				uuid,
				index,
			);
			if (!plan.ok) return undefined;
			if (plan.mutations.length === 0) {
				const ordered = orderedCaseOperations(
					docApi.getState().forms[formUuid] ?? {},
				);
				const currentIndex = ordered.findIndex(
					(operation) => operation.uuid === uuid,
				);
				return currentIndex < 0
					? undefined
					: {
							ok: true as const,
							index: currentIndex,
							total: ordered.length,
						};
			}
			const outcome = mutations.inline.commitMany([...plan.mutations]);
			if (!outcome.ok) return outcome;
			const committed = orderedCaseOperations(
				docApi.getState().forms[formUuid] ?? {},
			);
			const committedIndex = committed.findIndex(
				(operation) => operation.uuid === uuid,
			);
			if (committedIndex < 0) return undefined;
			return {
				ok: true as const,
				index: committedIndex,
				total: committed.length,
			};
		},
		[docApi, formUuid, mutations],
	);

	return {
		operations,
		inheritedGuards,
		nameOf,
		removalBlockers,
		dependenciesOf,
		moveVerdicts,
		removalPlan,
		editVerdict,
		addVerdict,
		authoringVerdict,
		add,
		update,
		remove,
		move,
	};
}
