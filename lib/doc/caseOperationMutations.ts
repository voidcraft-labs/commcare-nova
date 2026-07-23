import {
	type BlueprintDoc,
	type CaseOperation,
	type Form,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";
import {
	caseOperationDependencyUuids,
	caseOperationTargetTypeOrderViolations,
	caseOperationWireOrderViolations,
} from "./caseOperationOrder";
import { plannedMoveSlotKey } from "./order/keys";
import { caseOperationCatalogMutations } from "./scaffolds";
import type { Mutation } from "./types";

export type CaseOperationMutationPlan =
	| { readonly ok: true; readonly mutations: readonly Mutation[] }
	| {
			readonly ok: false;
			readonly reason:
				| "operation-not-found"
				| "dependent-reference"
				| "execution-order";
			readonly dependentUuids: readonly Uuid[];
	  };

export function addCaseOperationMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operation: CaseOperation,
	index?: number,
): Mutation[] {
	const form = doc.forms[formUuid];
	if (form === undefined) return [];
	const ordered = orderedCaseOperations(form);
	const value = {
		...operation,
		order:
			operation.order ??
			plannedMoveSlotKey(
				ordered.map((candidate) => candidate.order),
				index ?? ordered.length,
			),
	};
	return [
		...caseOperationCatalogMutations(doc, value),
		{
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationChange: { operation: "add", value },
		},
	];
}

export function updateCaseOperationMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operation: CaseOperation,
): Mutation[] {
	const existing = doc.forms[formUuid]?.caseOperations?.find(
		(candidate) => candidate.uuid === operation.uuid,
	);
	if (existing === undefined) return [];
	const value = {
		...operation,
		order: operation.order ?? existing.order,
	};
	return [
		...caseOperationCatalogMutations(doc, value),
		{
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationChange: {
				operation: "update",
				uuid: value.uuid,
				value,
			},
		},
	];
}

export function removeCaseOperationMutation(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): CaseOperationMutationPlan {
	const form = doc.forms[formUuid];
	if (
		form === undefined ||
		!(form.caseOperations ?? []).some((op) => op.uuid === uuid)
	) {
		return { ok: false, reason: "operation-not-found", dependentUuids: [] };
	}
	const dependentUuids = caseOperationDependents(form, uuid);
	if (dependentUuids.length > 0) {
		return { ok: false, reason: "dependent-reference", dependentUuids };
	}
	const prospective: Form = {
		...form,
		caseOperations: (form.caseOperations ?? []).filter(
			(operation) => operation.uuid !== uuid,
		),
	};
	const typeDependents = introducedTargetTypeViolationUuids(
		doc,
		formUuid,
		form,
		prospective,
	);
	if (typeDependents.length > 0) {
		return {
			ok: false,
			reason: "dependent-reference",
			dependentUuids: typeDependents,
		};
	}
	return {
		ok: true,
		mutations: [
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: { operation: "remove", uuid },
			},
		],
	};
}

export function moveCaseOperationMutation(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
	index: number,
): CaseOperationMutationPlan {
	const form = doc.forms[formUuid];
	if (form === undefined) {
		return { ok: false, reason: "operation-not-found", dependentUuids: [] };
	}
	const ordered = orderedCaseOperations(form);
	const operation = ordered.find((candidate) => candidate.uuid === uuid);
	if (operation === undefined) {
		return { ok: false, reason: "operation-not-found", dependentUuids: [] };
	}
	const without = ordered.filter((candidate) => candidate.uuid !== uuid);
	const order = plannedMoveSlotKey(
		without.map((candidate) => candidate.order),
		Math.max(0, Math.min(index, without.length)),
	);
	const prospective: Form = {
		...form,
		caseOperations: (form.caseOperations ?? []).map((candidate) =>
			candidate.uuid === uuid ? { ...candidate, order } : candidate,
		),
	};
	const broken = dependencyOrderViolations(prospective);
	if (broken.length > 0) {
		return {
			ok: false,
			reason: "dependent-reference",
			dependentUuids: broken,
		};
	}
	const typeDependents = introducedTargetTypeViolationUuids(
		doc,
		formUuid,
		form,
		prospective,
	);
	if (typeDependents.length > 0) {
		return {
			ok: false,
			reason: "dependent-reference",
			dependentUuids: typeDependents,
		};
	}
	const wireOrderBroken = caseOperationWireOrderViolations(doc, formUuid, [
		...orderedCaseOperations(prospective),
	]);
	if (wireOrderBroken.length > 0) {
		return {
			ok: false,
			reason: "execution-order",
			dependentUuids: wireOrderBroken,
		};
	}
	return {
		ok: true,
		mutations: [
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: { operation: "move", uuid, order },
			},
		],
	};
}

function introducedTargetTypeViolationUuids(
	doc: BlueprintDoc,
	formUuid: Uuid,
	before: Form,
	after: Form,
): Uuid[] {
	const beforeKeys = new Set(
		caseOperationTargetTypeOrderViolations(
			doc,
			formUuid,
			orderedCaseOperations(before),
		).map(targetTypeViolationKey),
	);
	return [
		...new Set(
			caseOperationTargetTypeOrderViolations(
				doc,
				formUuid,
				orderedCaseOperations(after),
			)
				.filter(
					(violation) => !beforeKeys.has(targetTypeViolationKey(violation)),
				)
				.map((violation) => violation.operationUuid),
		),
	];
}

function targetTypeViolationKey(violation: {
	readonly operationUuid: Uuid;
	readonly slot: string;
	readonly expectedType: string;
	readonly actualType: string;
	readonly kind: string;
}): string {
	return `${violation.operationUuid}:${violation.slot}:${violation.expectedType}:${violation.actualType}:${violation.kind}`;
}

export function caseOperationDependents(form: Form, uuid: Uuid): Uuid[] {
	return orderedCaseOperations(form)
		.filter((operation) => operation.uuid !== uuid)
		.filter((operation) => caseOperationDependencyUuids(operation).has(uuid))
		.map((operation) => operation.uuid);
}

function dependencyOrderViolations(form: Form): Uuid[] {
	const seen = new Set<Uuid>();
	const broken = new Set<Uuid>();
	for (const operation of orderedCaseOperations(form)) {
		for (const dependency of caseOperationDependencyUuids(operation)) {
			if (!seen.has(dependency)) broken.add(operation.uuid);
		}
		if (operation.action === "create") seen.add(operation.uuid);
	}
	return [...broken];
}
