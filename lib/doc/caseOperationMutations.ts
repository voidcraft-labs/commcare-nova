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
import {
	describeIntroducedErrors,
	mutationCommitVerdict,
} from "./commitVerdicts";
import { deepEqual } from "./deepEqual";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "./lookupReferences";
import { plannedMoveSlotKey } from "./order/keys";
import { caseOperationCatalogMutations } from "./scaffolds";
import type { Mutation } from "./types";

type UpdateFormMutation = Extract<Mutation, { kind: "updateForm" }>;
type CaseOperationPatch = NonNullable<UpdateFormMutation["caseOperationPatch"]>;
type OperationPatch = Extract<
	CaseOperationPatch,
	{ operation: "update" }
>["patch"];
type WritePatch = Extract<
	CaseOperationPatch,
	{ operation: "update-write" }
>["patch"];
type LinkPatch = Extract<
	CaseOperationPatch,
	{ operation: "update-link" }
>["patch"];

const OPERATION_PATCH_KEYS = [
	"id",
	"action",
	"caseType",
	"target",
	"condition",
	"forEach",
	"name",
	"owner",
	"rename",
	"retype",
] as const satisfies readonly (keyof OperationPatch)[];

function clearable<T>(value: T | undefined): T | null {
	return value === undefined ? null : structuredClone(value);
}

function operationMutation(
	formUuid: Uuid,
	patch: CaseOperationPatch,
	fallbackValue: CaseOperation,
): UpdateFormMutation {
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		caseOperationChange: {
			operation: "update",
			uuid: fallbackValue.uuid,
			value: structuredClone(fallbackValue),
		},
		caseOperationPatch: patch,
	};
}

/**
 * Identity-keyed edits that turn one operation snapshot into another.
 *
 * The operation itself, each write (by property), and each link (by
 * identifier) are independent merge units. Replaying a stale edit to one slot
 * on a document where a peer changed another therefore composes instead of
 * replacing the peer's whole operation.
 */
export function caseOperationChangesForUpdate(
	formUuid: Uuid,
	before: CaseOperation,
	after: CaseOperation,
): Mutation[] {
	if (before.uuid !== after.uuid) return [];
	const mutations: Mutation[] = [];

	const patch: OperationPatch = {};
	for (const key of OPERATION_PATCH_KEYS) {
		if (deepEqual(before[key], after[key])) continue;
		patch[key] = clearable(after[key]) as never;
	}
	if (Object.keys(patch).length > 0) {
		mutations.push(
			operationMutation(
				formUuid,
				{
					operation: "update",
					uuid: before.uuid,
					patch,
				},
				after,
			),
		);
	}

	const beforeWrites = new Map(
		(before.writes ?? []).map((write) => [write.property, write]),
	);
	const afterWrites = new Map(
		(after.writes ?? []).map((write) => [write.property, write]),
	);
	for (const [property] of beforeWrites) {
		if (afterWrites.has(property)) continue;
		mutations.push(
			operationMutation(
				formUuid,
				{
					operation: "remove-write",
					uuid: before.uuid,
					property,
				},
				after,
			),
		);
	}
	for (const [index, write] of (after.writes ?? []).entries()) {
		const prior = beforeWrites.get(write.property);
		if (prior === undefined) {
			mutations.push(
				operationMutation(
					formUuid,
					{
						operation: "add-write",
						uuid: before.uuid,
						value: structuredClone(write),
						index,
					},
					after,
				),
			);
			continue;
		}
		const writePatch: WritePatch = {};
		if (!deepEqual(prior.value, write.value)) {
			writePatch.value = structuredClone(write.value);
		}
		if (!deepEqual(prior.condition, write.condition)) {
			writePatch.condition = clearable(write.condition);
		}
		if (Object.keys(writePatch).length > 0) {
			mutations.push(
				operationMutation(
					formUuid,
					{
						operation: "update-write",
						uuid: before.uuid,
						property: write.property,
						patch: writePatch,
					},
					after,
				),
			);
		}
	}

	const beforeLinks = new Map(
		(before.links ?? []).map((link) => [link.identifier, link]),
	);
	const afterLinks = new Map(
		(after.links ?? []).map((link) => [link.identifier, link]),
	);
	for (const [identifier] of beforeLinks) {
		if (afterLinks.has(identifier)) continue;
		mutations.push(
			operationMutation(
				formUuid,
				{
					operation: "remove-link",
					uuid: before.uuid,
					identifier,
				},
				after,
			),
		);
	}
	for (const [index, link] of (after.links ?? []).entries()) {
		const prior = beforeLinks.get(link.identifier);
		if (prior === undefined) {
			mutations.push(
				operationMutation(
					formUuid,
					{
						operation: "add-link",
						uuid: before.uuid,
						value: structuredClone(link),
						index,
					},
					after,
				),
			);
			continue;
		}
		const linkPatch: LinkPatch = {};
		for (const key of [
			"targetType",
			"target",
			"relationship",
		] as const satisfies readonly (keyof LinkPatch)[]) {
			if (deepEqual(prior[key], link[key])) continue;
			linkPatch[key] = structuredClone(link[key]) as never;
		}
		if (Object.keys(linkPatch).length > 0) {
			mutations.push(
				operationMutation(
					formUuid,
					{
						operation: "update-link",
						uuid: before.uuid,
						identifier: link.identifier,
						patch: linkPatch,
					},
					after,
				),
			);
		}
	}

	if (!deepEqual(before.order, after.order)) {
		mutations.push(
			operationMutation(
				formUuid,
				{
					operation: "move",
					uuid: before.uuid,
					order: after.order ?? null,
				},
				after,
			),
		);
	}

	return mutations;
}

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

export type CaseOperationEditVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

/**
 * The shared builder-choice oracle for one complete operation candidate.
 *
 * Pickers ask this before offering a case type/action/link choice; the actual
 * commit still runs through the same gate. Keeping the planner + commit verdict
 * here means React never re-derives target-type, execution-order, reserved-name,
 * or facet rules.
 */
export function caseOperationEditVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operation: CaseOperation,
): CaseOperationEditVerdict {
	const exists =
		doc.forms[formUuid]?.caseOperations?.some(
			(candidate) => candidate.uuid === operation.uuid,
		) === true;
	if (!exists) {
		return {
			ok: false,
			reason: "This case change is no longer part of the form.",
		};
	}
	const mutations = updateCaseOperationMutations(doc, formUuid, operation);
	if (mutations.length === 0) return { ok: true };
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return verdict.ok
		? { ok: true }
		: {
				ok: false,
				reason: describeIntroducedErrors(verdict.introduced),
			};
}

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
		...caseOperationChangesForUpdate(formUuid, existing, value),
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
