import {
	type BlueprintDoc,
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	type Form,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";
import {
	caseOperationDependencyUuids,
	caseOperationTargetTypeOrderViolations,
	caseOperationWireOrderViolations,
} from "./caseOperationOrder";
import { mutationCommitVerdict } from "./commitVerdicts";
import { deepEqual } from "./deepEqual";
import { caseOperationContainsDormantLookupCarrier } from "./dormantLookupCarriers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "./lookupReferences";
import { caseOperationCatalogMutations } from "./scaffolds";
import type { Mutation } from "./types";
import { offeredChoiceRefusal } from "./userFacingErrors";

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
 * An ordinary move has an exact carrier-blind spelling in the established
 * grammar, so use it as the rolling fallback instead of embedding the whole
 * operation in a replacement. This is what lets a lookup-carrier-bearing
 * operation move without putting its dormant AST inside `mutationSchema`.
 *
 * `index` is current-only intent. The authoritative writer checks that the
 * fractional key still lands at this rank on its fresh snapshot; a peer
 * insertion that changes the rank becomes a conflict instead of false success.
 * A move that re-keys tied siblings passes it only for the operation the AUTHOR
 * moved — see the trailing rank loop in `lib/db/commitGuard.ts`.
 */
function moveOperationMutation(
	formUuid: Uuid,
	uuid: Uuid,
	after: Uuid | null,
): UpdateFormMutation {
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		caseOperationChange: { operation: "move", uuid, after },
		caseOperationPatch: { operation: "move", uuid, after },
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

/** Whether two keyed sequences hold the same keys in a different order.
 *  Membership changes are handled by the add/remove paths; this asks
 *  only about ORDER, which key-wise pairing cannot see. */
function sequenceChanged<T>(
	before: readonly T[] | undefined,
	after: readonly T[] | undefined,
	keyOf: (item: T) => string,
): boolean {
	const a = (before ?? []).map(keyOf);
	const b = (after ?? []).map(keyOf);
	if (a.length !== b.length) return false;
	return a.some((key, index) => key !== b[index]);
}

export function caseOperationChangesForUpdate(
	formUuid: Uuid,
	before: CaseOperation,
	after: CaseOperation,
): Mutation[] {
	if (before.uuid !== after.uuid) return [];

	// Writes and links pair by their logical key — a write's destination
	// property, a link's identifier — which is what lets two peers edit
	// different writes without clobbering each other. A pure REORDER
	// changes no key and no content, so key-wise pairing sees nothing
	// and the author's edit would be silently discarded. Sequence is
	// authored data here (it is the order the wire executes them in), so
	// a changed sequence falls back to replacing the whole operation,
	// which is exactly what the full-value change expresses.
	if (
		sequenceChanged(before.writes, after.writes, (write) => write.property) ||
		sequenceChanged(before.links, after.links, (link) => link.identifier)
	) {
		// A whole-operation replacement, with NO granular intent beside
		// it: there is no per-slot spelling for "these writes now run in
		// this order", and the established full-value change says it
		// exactly. The order slot is still diffed below the guard, so a
		// reorder combined with a move keeps both.
		return [
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: {
					operation: "update",
					uuid: before.uuid,
					value: structuredClone(after),
				},
			},
		];
	}

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

	return mutations;
}

/**
 * Which fact a `dependent-reference` refusal is about.
 *
 * Two different constraints refuse under that one reason, and a sentence
 * that is true of one is false of the other: a `reference` blocker holds
 * an `id-of` edge to this operation, while a `target-type` blocker would
 * be left acting on a case of a type an earlier change no longer
 * establishes. Only the planner can tell them apart — the `id-of` walk a
 * surface can do for itself cannot see the second kind at all — so the
 * cause travels with the refusal instead of being guessed downstream.
 */
export type CaseOperationDependencyKind = "reference" | "target-type";

export type CaseOperationMutationPlan =
	| { readonly ok: true; readonly mutations: readonly Mutation[] }
	| {
			readonly ok: false;
			readonly reason: "dependent-reference";
			readonly dependencyKind: CaseOperationDependencyKind;
			readonly dependentUuids: readonly Uuid[];
	  }
	| {
			readonly ok: false;
			readonly reason: "operation-not-found" | "execution-order";
			readonly dependentUuids: readonly Uuid[];
	  };

export type CaseOperationEditVerdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

export const CASE_OPERATION_DORMANT_LOOKUP_EDIT_REASON =
	"This case change uses lookup-table logic that Nova preserves but cannot safely edit from this surface.";

/** Whether a canonical operation can be authored by the currently shared
 * builder/SA/MCP vocabulary. Moving is intentionally outside this verdict:
 * an identity-keyed move never needs to project or replace the operation's
 * hidden AST. */
export function caseOperationAuthoringVerdict(
	operation: CaseOperation,
): CaseOperationEditVerdict {
	return caseOperationContainsDormantLookupCarrier(operation)
		? {
				ok: false,
				reason: CASE_OPERATION_DORMANT_LOOKUP_EDIT_REASON,
			}
		: { ok: true };
}

const CASE_OPERATION_STALE_EDIT_REASON =
	"This case change changed while you were editing it. Review the latest version and try again.";

export type CaseOperationUpdatePlan =
	| { readonly ok: true; readonly mutations: readonly Mutation[] }
	| { readonly ok: false; readonly reason: string };

type RebasedOperationEdit =
	| { readonly ok: true; readonly operation: CaseOperation }
	| { readonly ok: false };

/**
 * Rebase one render-snapshot edit onto the operation currently in the store.
 *
 * The UI hands back a complete operation shape, but the user's intent is only
 * the slots that differ from the shape they saw. Applying that intent to the
 * fresh member preserves a peer's unrelated scalar/write/link edits. Missing
 * logical targets and same-key additions are conflicts: silently accepting
 * either would let the total reducer return `ok: true` for a no-op.
 */
function rebaseCaseOperationEdit(
	base: CaseOperation,
	desired: CaseOperation,
	current: CaseOperation,
): RebasedOperationEdit {
	if (
		base.uuid !== desired.uuid ||
		base.uuid !== current.uuid ||
		desired.uuid !== current.uuid
	) {
		return { ok: false };
	}

	const rebased = structuredClone(current);
	const target = rebased as unknown as Record<string, unknown>;
	for (const key of OPERATION_PATCH_KEYS) {
		if (deepEqual(base[key], desired[key])) continue;
		const value = desired[key];
		if (value === undefined) delete target[key];
		else target[key] = structuredClone(value);
	}

	const baseWrites = new Map(
		(base.writes ?? []).map((write) => [write.property, write]),
	);
	const desiredWrites = new Map(
		(desired.writes ?? []).map((write) => [write.property, write]),
	);
	const rebasedWrites: CaseOperationWrite[] = structuredClone(
		current.writes ?? [],
	);
	for (const property of baseWrites.keys()) {
		if (desiredWrites.has(property)) continue;
		const index = rebasedWrites.findIndex(
			(write) => write.property === property,
		);
		if (index < 0) return { ok: false };
		rebasedWrites.splice(index, 1);
	}
	for (const [desiredIndex, write] of (desired.writes ?? []).entries()) {
		const prior = baseWrites.get(write.property);
		const currentIndex = rebasedWrites.findIndex(
			(candidate) => candidate.property === write.property,
		);
		if (prior === undefined) {
			if (currentIndex >= 0) return { ok: false };
			rebasedWrites.splice(
				Math.max(0, Math.min(desiredIndex, rebasedWrites.length)),
				0,
				structuredClone(write),
			);
			continue;
		}
		if (deepEqual(prior, write)) continue;
		if (currentIndex < 0) return { ok: false };
		const currentWrite = rebasedWrites[currentIndex];
		if (!deepEqual(prior.value, write.value)) {
			currentWrite.value = structuredClone(write.value);
		}
		if (!deepEqual(prior.condition, write.condition)) {
			if (write.condition === undefined) delete currentWrite.condition;
			else currentWrite.condition = structuredClone(write.condition);
		}
	}
	if (rebasedWrites.length === 0) delete rebased.writes;
	else rebased.writes = rebasedWrites;

	const baseLinks = new Map(
		(base.links ?? []).map((link) => [link.identifier, link]),
	);
	const desiredLinks = new Map(
		(desired.links ?? []).map((link) => [link.identifier, link]),
	);
	const rebasedLinks: CaseOperationLink[] = structuredClone(
		current.links ?? [],
	);
	for (const identifier of baseLinks.keys()) {
		if (desiredLinks.has(identifier)) continue;
		const index = rebasedLinks.findIndex(
			(link) => link.identifier === identifier,
		);
		if (index < 0) return { ok: false };
		rebasedLinks.splice(index, 1);
	}
	for (const [desiredIndex, link] of (desired.links ?? []).entries()) {
		const prior = baseLinks.get(link.identifier);
		const currentIndex = rebasedLinks.findIndex(
			(candidate) => candidate.identifier === link.identifier,
		);
		if (prior === undefined) {
			if (currentIndex >= 0) return { ok: false };
			rebasedLinks.splice(
				Math.max(0, Math.min(desiredIndex, rebasedLinks.length)),
				0,
				structuredClone(link),
			);
			continue;
		}
		if (deepEqual(prior, link)) continue;
		if (currentIndex < 0) return { ok: false };
		const currentLink = rebasedLinks[currentIndex];
		for (const key of ["targetType", "target", "relationship"] as const) {
			if (deepEqual(prior[key], link[key])) continue;
			currentLink[key] = structuredClone(link[key]) as never;
		}
	}
	if (rebasedLinks.length === 0) delete rebased.links;
	else rebased.links = rebasedLinks;

	return { ok: true, operation: rebased };
}

/**
 * Plan a full-shape edit against the current doc while retaining the
 * render/tool snapshot that defines the caller's actual intent.
 *
 * Lookup-carrier-bearing operations are read-only until that vocabulary is
 * authorable on all three editors. This refusal occurs before construction of
 * a rolling mutation, so a carrier-blind read can never clear hidden behavior
 * and the builder can never enter the permanent-400 autosave state.
 */
export function planCaseOperationUpdate(
	doc: BlueprintDoc,
	formUuid: Uuid,
	desired: CaseOperation,
	base?: CaseOperation,
): CaseOperationUpdatePlan {
	const current = doc.forms[formUuid]?.caseOperations?.find(
		(candidate) => candidate.uuid === desired.uuid,
	);
	if (current === undefined) {
		return {
			ok: false,
			reason: "This case change is no longer part of the form.",
		};
	}
	const intentBase = base ?? current;
	const normalizedDesired: CaseOperation = { ...desired };
	if (deepEqual(intentBase, normalizedDesired)) {
		return { ok: true, mutations: [] };
	}
	if (
		!caseOperationAuthoringVerdict(current).ok ||
		!caseOperationAuthoringVerdict(intentBase).ok
	) {
		return {
			ok: false,
			reason: CASE_OPERATION_DORMANT_LOOKUP_EDIT_REASON,
		};
	}
	const rebased = rebaseCaseOperationEdit(
		intentBase,
		normalizedDesired,
		current,
	);
	if (!rebased.ok) {
		return { ok: false, reason: CASE_OPERATION_STALE_EDIT_REASON };
	}
	return {
		ok: true,
		mutations: updateCaseOperationMutations(doc, formUuid, rebased.operation),
	};
}

const EDIT_VERDICT_CACHE = new WeakMap<
	BlueprintDoc,
	Map<string, CaseOperationEditVerdict>
>();

/**
 * The shared builder-choice oracle for one complete operation candidate.
 *
 * Pickers ask this before offering a case type/action/link choice; the actual
 * commit still runs through the same gate. Keeping the planner + commit verdict
 * here means React never re-derives target-type, execution-order, reserved-name,
 * or facet rules.
 *
 * Memoized per (doc reference, form uuid, candidate operation) — the
 * `validationContextFor` discipline. A menu asks this once per OFFERED choice,
 * so one open case-type picker runs a whole-document validation per case type,
 * and its surrounding component re-renders on every keystroke in the
 * create-new box. The candidate is the cache key because it is what varies
 * across those calls: a caller builds it by spreading the current operation, so
 * the same offered choice serializes identically every render, while any
 * committed batch mints a fresh doc reference and drops the whole map.
 *
 * Deliberately NOT applied to `caseOperationAddVerdict`: its callers mint a
 * fresh operation uuid per probe (`seedCaseOperation`), so every call would be
 * a miss and the map would only grow. That path stabilizes its callback at the
 * React layer instead.
 */
export function caseOperationEditVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operation: CaseOperation,
): CaseOperationEditVerdict {
	const cacheKey = `${formUuid}\u0000${JSON.stringify(operation)}`;
	let perCandidate = EDIT_VERDICT_CACHE.get(doc);
	if (perCandidate === undefined) {
		perCandidate = new Map();
		EDIT_VERDICT_CACHE.set(doc, perCandidate);
	}
	const cached = perCandidate.get(cacheKey);
	if (cached !== undefined) return cached;
	const verdict = computeCaseOperationEditVerdict(doc, formUuid, operation);
	perCandidate.set(cacheKey, verdict);
	return verdict;
}

function computeCaseOperationEditVerdict(
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
	const plan = planCaseOperationUpdate(doc, formUuid, operation);
	if (!plan.ok) return plan;
	if (plan.mutations.length === 0) return { ok: true };
	const verdict = mutationCommitVerdict(
		doc,
		[...plan.mutations],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return verdict.ok
		? { ok: true }
		: {
				ok: false,
				reason: offeredChoiceRefusal(verdict.introduced),
			};
}

/**
 * The shared builder-choice oracle for one complete operation insertion.
 *
 * Add controls use this before enabling an intent, then the actual dispatch
 * repeats the full commit gate against the invocation-time document. That
 * keeps a rolling session retype or another ordering constraint from turning
 * an enabled add action into an avoidable rejected commit.
 */
export function caseOperationAddVerdict(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operation: CaseOperation,
	index?: number,
): CaseOperationEditVerdict {
	const form = doc.forms[formUuid];
	if (form === undefined) {
		return {
			ok: false,
			reason: "This form is no longer part of the app.",
		};
	}
	if (
		(form.caseOperations ?? []).some(
			(candidate) => candidate.uuid === operation.uuid,
		)
	) {
		return {
			ok: false,
			reason:
				"This case change was added elsewhere first. Review the latest list and try again.",
		};
	}
	const verdict = mutationCommitVerdict(
		doc,
		addCaseOperationMutations(doc, formUuid, operation, index),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return verdict.ok
		? { ok: true }
		: {
				ok: false,
				reason: offeredChoiceRefusal(verdict.introduced),
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
	const value = { ...operation };
	// An indexed add lands the operation, then moves it into place. It needs no
	// companion re-keying of its neighbours: a ranked landing used to be
	// unreachable inside a run of equal keys, so the planner had to re-key the
	// siblings to open a gap. An array index has no such run.
	const at = index ?? ordered.length;
	const previous = at > 0 ? (ordered[at - 1]?.uuid ?? null) : null;
	return [
		...caseOperationCatalogMutations(doc, value),
		{
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationChange: { operation: "add", value },
		},
		...(at >= ordered.length
			? []
			: [moveOperationMutation(formUuid, operation.uuid, previous)]),
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
	const value = { ...operation };
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
		return {
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "reference",
			dependentUuids,
		};
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
			dependencyKind: "target-type",
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
	const targetIndex = Math.max(0, Math.min(index, without.length));
	const currentIndex = ordered.findIndex(
		(candidate) => candidate.uuid === uuid,
	);
	if (targetIndex === currentIndex) {
		// An already-placed operation is a true no-op: do not mint a different
		// fractional key for the same rank. Apart from pointless multiplayer
		// traffic, that would create an undo entry for a gesture that changed
		// nothing the author can observe.
		return { ok: true, mutations: [] };
	}
	// Where the operation lands: the uuid it will follow in the new sequence.
	const after =
		targetIndex > 0 ? (without[targetIndex - 1]?.uuid ?? null) : null;
	// The verdicts below must see the ACTUAL landing. That used to mean carrying
	// the mover's minted key AND every sibling the planner re-keyed to open a
	// gap for it — a ranked destination inside a run of equal keys was
	// unreachable by any single key. Splicing the array reaches every rank, so
	// the prospective form is just the reordered sequence.
	const landed = [...without];
	landed.splice(targetIndex, 0, ordered[currentIndex]);
	const prospective: Form = { ...form, caseOperations: landed };
	const broken = dependencyOrderViolations(prospective);
	if (broken.length > 0) {
		return {
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "reference",
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
			dependencyKind: "target-type",
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
		mutations: [moveOperationMutation(formUuid, uuid, after)],
	};
}

/**
 * The BEFORE half of the introduced-violation diff, memoized per
 * (doc reference, form reference) — the `validationContextFor`
 * discipline this package already follows.
 *
 * `caseOperationMoveVerdicts` asks the move planner about every
 * destination at once, and each call re-derived this identical answer
 * from the same unmodified form: an N-operation form ran the whole-form
 * target-type analysis N times for one unchanging result, on every
 * render that opens a reorder handle. Both keys are immer products, so
 * any real change to either mints a new reference and misses the cache.
 */
const BEFORE_TARGET_TYPE_KEYS = new WeakMap<
	BlueprintDoc,
	WeakMap<Form, ReadonlySet<string>>
>();

function beforeTargetTypeViolationKeys(
	doc: BlueprintDoc,
	formUuid: Uuid,
	before: Form,
): ReadonlySet<string> {
	let perForm = BEFORE_TARGET_TYPE_KEYS.get(doc);
	if (perForm === undefined) {
		perForm = new WeakMap();
		BEFORE_TARGET_TYPE_KEYS.set(doc, perForm);
	}
	const cached = perForm.get(before);
	if (cached !== undefined) return cached;
	const keys = new Set(
		caseOperationTargetTypeOrderViolations(
			doc,
			formUuid,
			orderedCaseOperations(before),
		).map(targetTypeViolationKey),
	);
	perForm.set(before, keys);
	return keys;
}

function introducedTargetTypeViolationUuids(
	doc: BlueprintDoc,
	formUuid: Uuid,
	before: Form,
	after: Form,
): Uuid[] {
	const beforeKeys = beforeTargetTypeViolationKeys(doc, formUuid, before);
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
