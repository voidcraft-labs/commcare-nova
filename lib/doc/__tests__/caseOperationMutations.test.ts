import { proseText } from "@/lib/domain/prose";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { batchTargetsMissing } from "@/lib/db/commitGuard";
import {
	addCaseOperationMutations,
	caseOperationEditVerdict,
	moveCaseOperationMutation,
	planCaseOperationUpdate,
	removeCaseOperationMutation,
	updateCaseOperationMutations,
} from "@/lib/doc/caseOperationMutations";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { rewriteFormSearchInputRefs } from "@/lib/doc/mutations/referenceRewrites";
import {
	buildReferenceIndex,
	declarersOf,
	referencingSlotsOf,
} from "@/lib/doc/referenceIndex";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseOperation,
	casePropertyTargetKey,
	caseTypeTargetKey,
	entityTargetKey,
	type Form,
	orderedCaseOperations,
} from "@/lib/domain";
import {
	eq,
	exists,
	formField,
	idOf,
	input,
	literal,
	prop,
	subcasePath,
	term,
} from "@/lib/domain/predicate";

const CREATE = testUuid("11111111-1111-4111-8111-111111111111");
const CONSUMER = testUuid("22222222-2222-4222-8222-222222222222");
const OTHER = testUuid("33333333-3333-4333-8333-333333333333");
const NAME = testUuid("44444444-4444-4444-8444-444444444444");
const REPEAT = testUuid("55555555-5555-4555-8555-555555555555");

function fixture(): {
	doc: BlueprintDoc;
	formUuid: ReturnType<typeof testUuid>;
} {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "nickname", label: proseText("Nickname") }],
			},
			{
				name: "visit",
				properties: [{ name: "source_id", label: proseText("Source ID") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Edit",
						type: "followup",
						fields: [
							f({
								uuid: NAME,
								kind: "text",
								id: "nickname",
								label: "Nickname",
								case_property_on: "patient",
							}),
							f({
								uuid: REPEAT,
								kind: "repeat",
								id: "visits",
								label: "Visits",
								repeat_mode: "user_controlled",
								children: [],
							}),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	return { doc, formUuid: doc.formOrder[moduleUuid][0] };
}

function createOperation(patch: Partial<CaseOperation> = {}): CaseOperation {
	return {
		uuid: CREATE,
		id: "create_visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: term(literal("Visit")),
		...patch,
	};
}

function consumerOperation(patch: Partial<CaseOperation> = {}): CaseOperation {
	return {
		uuid: CONSUMER,
		id: "tag_visit",
		action: "update",
		caseType: "visit",
		target: { kind: "op", opUuid: CREATE },
		writes: [{ property: "source_id", value: idOf(CREATE) }],
		...patch,
	};
}

function apply(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

describe("case-operation mutation planning", () => {
	it("adds catalog prerequisites before the semantic form edit", () => {
		const { doc, formUuid } = fixture();
		const operation = createOperation({
			caseType: "message",
			writes: [{ property: "payload", value: term(literal("hello")) }],
		});
		const mutations = addCaseOperationMutations(doc, formUuid, operation);

		expect(mutations.map((mutation) => mutation.kind)).toEqual([
			"declareCaseType",
			"addCaseProperty",
			"updateForm",
		]);
		expect(mutations.at(-1)).toMatchObject({
			kind: "updateForm",
			caseOperationChange: { operation: "add", value: operation },
		});

		const next = apply(doc, mutations);
		expect(next.caseTypes?.find((type) => type.name === "message")).toEqual({
			name: "message",
			properties: [{ name: "payload", label: "Payload" }],
		});
		expect(next.forms[formUuid].caseOperations).toHaveLength(1);
	});

	it("leaves an operation where it sits when an update only changes content", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [
			createOperation(),
			consumerOperation(),
		];
		const mutations = updateCaseOperationMutations(doc, formUuid, {
			...createOperation(),
			name: term(literal("Renamed")),
		});
		const next = apply(doc, mutations);
		expect(
			next.forms[formUuid].caseOperations?.map((operation) => operation.uuid),
		).toEqual([CREATE, CONSUMER]);
		expect(next.forms[formUuid].caseOperations?.[0].name).toEqual(
			term(literal("Renamed")),
		);
	});

	it("applies a cross-type retarget as one scalar patch and one reducer state", () => {
		const { doc, formUuid } = fixture();
		const create = createOperation();
		const consumer = consumerOperation();
		(doc.forms[formUuid] as Form).caseOperations = [create, consumer];
		const desired: CaseOperation = {
			...consumer,
			caseType: "patient",
			target: { kind: "session" },
		};

		const mutations = updateCaseOperationMutations(doc, formUuid, desired);
		const operationUpdates = mutations.filter(
			(mutation) =>
				mutation.kind === "updateForm" &&
				mutation.caseOperationPatch?.operation === "update",
		);
		expect(operationUpdates).toHaveLength(1);
		expect(operationUpdates[0]).toMatchObject({
			caseOperationPatch: {
				operation: "update",
				uuid: CONSUMER,
				patch: {
					caseType: "patient",
					target: { kind: "session" },
				},
			},
		});

		const committed = apply(doc, mutations);
		expect(
			committed.forms[formUuid].caseOperations?.find(
				(operation) => operation.uuid === CONSUMER,
			),
		).toEqual(desired);
	});

	it("composes stale peer edits to different operation slots", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [createOperation()];

		const rename = updateCaseOperationMutations(doc, formUuid, {
			...createOperation(),
			id: "create_encounter",
		});
		const changeName = updateCaseOperationMutations(doc, formUuid, {
			...createOperation(),
			name: term(literal("Encounter")),
		});

		expect(rename).toContainEqual(
			expect.objectContaining({
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationPatch: {
					operation: "update",
					uuid: CREATE,
					patch: { id: "create_encounter" },
				},
			}),
		);
		expect(rename).toContainEqual(
			expect.objectContaining({
				caseOperationChange: {
					operation: "update",
					uuid: CREATE,
					value: expect.objectContaining({ id: "create_encounter" }),
				},
			}),
		);
		expect(changeName).toContainEqual(
			expect.objectContaining({
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationPatch: {
					operation: "update",
					uuid: CREATE,
					patch: { name: term(literal("Encounter")) },
				},
			}),
		);

		const next = apply(apply(doc, rename), changeName);
		expect(next.forms[formUuid].caseOperations?.[0]).toMatchObject({
			id: "create_encounter",
			name: term(literal("Encounter")),
		});
	});

	it("composes stale peer edits to different write slots", () => {
		const { doc, formUuid } = fixture();
		const original = consumerOperation({
			writes: [
				{ property: "source_id", value: term(literal("original")) },
				{ property: "note", value: term(literal("original")) },
			],
		});
		(doc.forms[formUuid] as Form).caseOperations = [original];

		const sourceEdit = updateCaseOperationMutations(doc, formUuid, {
			...original,
			writes: [
				{ property: "source_id", value: term(literal("source edit")) },
				{ property: "note", value: term(literal("original")) },
			],
		});
		const noteEdit = updateCaseOperationMutations(doc, formUuid, {
			...original,
			writes: [
				{ property: "source_id", value: term(literal("original")) },
				{ property: "note", value: term(literal("note edit")) },
			],
		});

		expect(sourceEdit).toContainEqual(
			expect.objectContaining({
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationPatch: {
					operation: "update-write",
					uuid: CONSUMER,
					property: "source_id",
					patch: { value: term(literal("source edit")) },
				},
			}),
		);
		expect(noteEdit).toContainEqual(
			expect.objectContaining({
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationPatch: {
					operation: "update-write",
					uuid: CONSUMER,
					property: "note",
					patch: { value: term(literal("note edit")) },
				},
			}),
		);

		const next = apply(apply(doc, sourceEdit), noteEdit);
		expect(next.forms[formUuid].caseOperations?.[0].writes).toEqual([
			{ property: "source_id", value: term(literal("source edit")) },
			{ property: "note", value: term(literal("note edit")) },
		]);
	});

	it("keeps a peer link-type edit when a stale author unlinks it", () => {
		const { doc, formUuid } = fixture();
		const original = consumerOperation({
			links: [
				{
					identifier: "parent",
					targetType: "patient",
					target: {
						kind: "expression",
						expr: term(literal("case-id")),
					},
					relationship: "child",
				},
			],
		});
		(doc.forms[formUuid] as Form).caseOperations = [
			createOperation(),
			original,
		];
		const originalLink = original.links?.[0];
		if (originalLink === undefined) throw new Error("link fixture missing");

		const peerTypeEdit = updateCaseOperationMutations(doc, formUuid, {
			...original,
			links: [{ ...originalLink, targetType: "visit" }],
		});
		const staleUnlink = updateCaseOperationMutations(doc, formUuid, {
			...original,
			links: [{ ...originalLink, target: null }],
		});

		expect(staleUnlink).toContainEqual(
			expect.objectContaining({
				caseOperationPatch: {
					operation: "update-link",
					uuid: CONSUMER,
					identifier: "parent",
					patch: { target: null },
				},
			}),
		);

		const next = apply(apply(doc, peerTypeEdit), staleUnlink);
		expect(next.forms[formUuid].caseOperations?.[1].links).toEqual([
			{
				...originalLink,
				targetType: "visit",
				target: null,
			},
		]);

		const fresh = apply(doc, peerTypeEdit);
		const plan = planCaseOperationUpdate(
			fresh,
			formUuid,
			{
				...original,
				links: [{ ...originalLink, target: null }],
			},
			original,
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(
			apply(fresh, plan.mutations).forms[formUuid].caseOperations?.[1].links,
		).toEqual([
			{
				...originalLink,
				targetType: "visit",
				target: null,
			},
		]);
	});

	it("rejects removal and reordering while later references depend on a create", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [
			createOperation(),
			consumerOperation(),
		];

		// An `id-of` edge, so the refusal reports itself as a reference one and
		// the review layer has slots to name.
		expect(removeCaseOperationMutation(doc, formUuid, CREATE)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "reference",
			dependentUuids: [CONSUMER],
		});
		expect(moveCaseOperationMutation(doc, formUuid, CREATE, 1)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "reference",
			dependentUuids: [CONSUMER],
		});
		expect(moveCaseOperationMutation(doc, formUuid, CONSUMER, 0)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "reference",
			dependentUuids: [CONSUMER],
		});
	});

	it("treats an ordered retype as a dependency of later same-target operations", () => {
		const { doc, formUuid } = fixture();
		const retype: CaseOperation = {
			uuid: CONSUMER,
			id: "retype_visit",
			action: "update",
			caseType: "visit",
			target: { kind: "op", opUuid: CREATE },
			retype: "patient",
		};
		const later: CaseOperation = {
			uuid: OTHER,
			id: "update_retyped_visit",
			action: "update",
			caseType: "patient",
			target: { kind: "op", opUuid: CREATE },
		};
		(doc.forms[formUuid] as Form).caseOperations = [
			createOperation(),
			retype,
			later,
		];

		// Nothing holds an `id-of` edge to the retype — what `later` depends on
		// is the TYPE it leaves behind, and the refusal has to say so or the
		// review layer has nothing it can find.
		expect(removeCaseOperationMutation(doc, formUuid, CONSUMER)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "target-type",
			dependentUuids: [OTHER],
		});
		expect(moveCaseOperationMutation(doc, formUuid, CONSUMER, 2)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "target-type",
			dependentUuids: [OTHER],
		});
	});

	it("rejects a move that introduces a possible runtime alias after retype", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: CONSUMER,
				id: "update_runtime_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "expression", expr: term(formField(NAME)) },
			},
			{
				uuid: OTHER,
				id: "retype_session_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				retype: "visit",
			},
		];

		expect(moveCaseOperationMutation(doc, formUuid, OTHER, 0)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependencyKind: "target-type",
			dependentUuids: [CONSUMER],
		});
	});

	it("moves independent operations with an absolute fractional key", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [
			createOperation(),
			consumerOperation(),
			{
				uuid: OTHER,
				id: "update_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
			},
		];
		const plan = moveCaseOperationMutation(doc, formUuid, OTHER, 0);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const next = apply(doc, plan.mutations);
		expect(
			orderedCaseOperations(next.forms[formUuid]).map(
				(operation) => operation.uuid,
			),
		).toEqual([OTHER, CREATE, CONSUMER]);
	});

	it("plans nothing for a move to where the operation already is", () => {
		const { doc, formUuid } = fixture();
		const current = createOperation();
		(doc.forms[formUuid] as Form).caseOperations = [
			current,
			consumerOperation(),
		];

		expect(moveCaseOperationMutation(doc, formUuid, current.uuid, 0)).toEqual({
			ok: true,
			mutations: [],
		});
	});

	it("rejects a move across multiplicity scopes when the wire cannot preserve it", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: OTHER,
				id: "update_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
			},
			createOperation({ forEach: { repeat: REPEAT } }),
		];

		expect(moveCaseOperationMutation(doc, formUuid, OTHER, 1)).toEqual({
			ok: false,
			reason: "execution-order",
			dependentUuids: [OTHER],
		});
	});

	it("keeps authored-id creates before non-create effects while generated creates stay fresh", () => {
		const { doc, formUuid } = fixture();
		const updatePatient: CaseOperation = {
			uuid: OTHER,
			id: "update_patient",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
		};
		(doc.forms[formUuid] as Form).caseOperations = [
			createOperation({ target: { kind: "new", idFrom: NAME } }),
			updatePatient,
		];

		expect(moveCaseOperationMutation(doc, formUuid, CREATE, 1)).toEqual({
			ok: false,
			reason: "execution-order",
			dependentUuids: [CREATE],
		});

		(doc.forms[formUuid] as Form).caseOperations = [
			createOperation(),
			updatePatient,
		];
		expect(moveCaseOperationMutation(doc, formUuid, CREATE, 1).ok).toBe(true);
	});
});

// A move asserts a RANK to the authoritative writer, so it has to land the
// operation at exactly the index the author asked for — every destination
// reachable, and the writer's fence agreeing that it landed there. Moving the
// first, a middle, and the last operation are separate cases because each
// splices differently.
describe("case-operation move lands at the rank it asserts", () => {
	const RANKED = [
		testUuid("aaaaaaaa-0000-4000-8000-000000000001"),
		testUuid("aaaaaaaa-0000-4000-8000-000000000002"),
		testUuid("aaaaaaaa-0000-4000-8000-000000000003"),
		testUuid("aaaaaaaa-0000-4000-8000-000000000004"),
	];

	/** An independent session update — nothing here constrains execution order. */
	function ranked(index: number): CaseOperation {
		return {
			uuid: RANKED[index],
			id: `update_patient_${index}`,
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
		};
	}

	function docWith(count: number) {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = Array.from(
			{ length: count },
			(_, index) => ranked(index),
		);
		return { doc, formUuid };
	}

	function landedIndex(
		doc: BlueprintDoc,
		formUuid: ReturnType<typeof testUuid>,
		uuid: ReturnType<typeof testUuid>,
		mutations: readonly Mutation[],
	): number {
		return orderedCaseOperations(
			apply(doc, mutations).forms[formUuid],
		).findIndex((operation) => operation.uuid === uuid);
	}

	it("drops the first operation inward, and the fence agrees", () => {
		const { doc, formUuid } = docWith(4);
		const plan = moveCaseOperationMutation(doc, formUuid, RANKED[0], 1);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(landedIndex(doc, formUuid, RANKED[0], plan.mutations)).toBe(1);
		expect(batchTargetsMissing(doc, [...plan.mutations])).toBe(false);
	});

	it("moves an operation up out of the middle", () => {
		const { doc, formUuid } = docWith(3);
		const plan = moveCaseOperationMutation(doc, formUuid, RANKED[2], 1);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(landedIndex(doc, formUuid, RANKED[2], plan.mutations)).toBe(1);
		expect(batchTargetsMissing(doc, [...plan.mutations])).toBe(false);
	});

	it("lifts the last operation one place (keyboard reorder)", () => {
		const { doc, formUuid } = docWith(4);
		const plan = moveCaseOperationMutation(doc, formUuid, RANKED[3], 2);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(landedIndex(doc, formUuid, RANKED[3], plan.mutations)).toBe(2);
		expect(batchTargetsMissing(doc, [...plan.mutations])).toBe(false);
	});

	it("lands at EVERY destination of the form", () => {
		const { doc, formUuid } = docWith(4);
		const ordered = orderedCaseOperations(doc.forms[formUuid]);
		const currentIndex = ordered.findIndex(
			(operation) => operation.uuid === RANKED[1],
		);
		for (let index = 0; index < ordered.length; index++) {
			const plan = moveCaseOperationMutation(doc, formUuid, RANKED[1], index);
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			if (index === currentIndex) {
				// Already there: no authoritative event, and no undo entry.
				expect(plan.mutations).toEqual([]);
			}
			expect(landedIndex(doc, formUuid, RANKED[1], plan.mutations)).toBe(index);
			expect(batchTargetsMissing(doc, [...plan.mutations])).toBe(false);
		}
	});

	it("adds an operation at a requested index", () => {
		const { doc, formUuid } = docWith(3);
		const mutations = addCaseOperationMutations(doc, formUuid, ranked(3), 1);
		expect(landedIndex(doc, formUuid, RANKED[3], mutations)).toBe(1);
		expect(batchTargetsMissing(doc, [...mutations])).toBe(false);
	});
});

describe("case-operation builder choice verdict", () => {
	it("rejects a target/type mismatch and accepts the action reshape that fixes both", () => {
		const { doc, formUuid } = fixture();
		const create = createOperation();
		(doc.forms[formUuid] as Form).caseOperations = [create];

		expect(
			caseOperationEditVerdict(doc, formUuid, {
				...create,
				action: "update",
				target: { kind: "session" },
				name: undefined,
			}),
		).toMatchObject({ ok: false });
		expect(
			caseOperationEditVerdict(doc, formUuid, {
				...create,
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				name: undefined,
			}),
		).toEqual({ ok: true });
	});

	it("rejects a retype choice that strands a later same-case consumer", () => {
		const { doc, formUuid } = fixture();
		const retype: CaseOperation = {
			uuid: CONSUMER,
			id: "retype_patient",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			retype: "visit",
		};
		const later: CaseOperation = {
			uuid: OTHER,
			id: "update_visit",
			action: "update",
			caseType: "visit",
			target: { kind: "session" },
		};
		(doc.forms[formUuid] as Form).caseOperations = [retype, later];

		expect(
			caseOperationEditVerdict(doc, formUuid, {
				...retype,
				retype: undefined,
			}),
		).toMatchObject({ ok: false });
		expect(caseOperationEditVerdict(doc, formUuid, retype)).toEqual({
			ok: true,
		});
	});

	it("rejects a link target type that disagrees with its chosen case", () => {
		const { doc, formUuid } = fixture();
		const create = createOperation();
		const updater: CaseOperation = {
			uuid: OTHER,
			id: "update_patient",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			links: [
				{
					identifier: "visit",
					targetType: "visit",
					target: { kind: "op", opUuid: CREATE },
					relationship: "child",
				},
			],
		};
		(doc.forms[formUuid] as Form).caseOperations = [create, updater];

		expect(caseOperationEditVerdict(doc, formUuid, updater)).toEqual({
			ok: true,
		});
		const link = updater.links?.[0];
		if (link === undefined) throw new Error("fixture link missing");
		expect(
			caseOperationEditVerdict(doc, formUuid, {
				...updater,
				links: [{ ...link, targetType: "patient" }],
			}),
		).toMatchObject({ ok: false });
	});

	it("rejects keying a generated create after an earlier non-create effect", () => {
		const { doc, formUuid } = fixture();
		const earlier: CaseOperation = {
			uuid: OTHER,
			id: "update_patient",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
		};
		const generated = createOperation();
		(doc.forms[formUuid] as Form).caseOperations = [earlier, generated];

		expect(caseOperationEditVerdict(doc, formUuid, generated)).toEqual({
			ok: true,
		});
		const verdict = caseOperationEditVerdict(doc, formUuid, {
			...generated,
			target: { kind: "new", idFrom: NAME },
		});
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		// The reason lands in a menu item's reason span, so it is one line in
		// the builder's voice — not the commit-rejection report, which speaks
		// in the past tense about an attempt nobody made and carries newlines
		// the span collapses into the middle of a sentence.
		expect(verdict.reason).not.toContain("\n");
		expect(verdict.reason).not.toContain("wasn't applied");
		expect(verdict.reason).not.toContain("Nothing was changed");
		expect(verdict.reason).not.toContain("try again");
	});

	it("rejects repeating a create when a later root operation consumes it", () => {
		const { doc, formUuid } = fixture();
		const create = createOperation();
		const consumer = consumerOperation();
		(doc.forms[formUuid] as Form).caseOperations = [create, consumer];

		expect(caseOperationEditVerdict(doc, formUuid, create)).toEqual({
			ok: true,
		});
		expect(
			caseOperationEditVerdict(doc, formUuid, {
				...create,
				forEach: { repeat: REPEAT },
			}),
		).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/repeat|iteration/i),
		});
	});
});

describe("case-operation persistence and reference participation", () => {
	it("rejects identity-changing and empty granular update patches at ingress", () => {
		const { formUuid } = fixture();
		const update = (
			caseOperationPatch: Record<string, unknown>,
			value: CaseOperation = createOperation(),
		) => ({
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationChange: { operation: "update", uuid: CREATE, value },
			caseOperationPatch,
		});

		expect(
			mutationSchema.safeParse(
				update({
					operation: "update",
					uuid: CREATE,
					patch: { uuid: OTHER },
				}),
			).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse(
				update({ operation: "update", uuid: CREATE, patch: {} }),
			).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse(
				update(
					{
						operation: "update-write",
						uuid: CREATE,
						property: "source_id",
						patch: {},
					},
					createOperation({
						writes: [{ property: "source_id", value: term(literal("x")) }],
					}),
				),
			).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse(
				update(
					{
						operation: "update-link",
						uuid: CREATE,
						identifier: "parent",
						patch: {},
					},
					createOperation({
						links: [
							{
								identifier: "parent",
								targetType: "patient",
								target: { kind: "session" },
								relationship: "child",
							},
						],
					}),
				),
			).success,
		).toBe(false);

		expect(
			mutationSchema.safeParse(
				update(
					{
						operation: "update",
						uuid: CREATE,
						patch: { id: "new_id" },
					},
					createOperation({ id: "different_id" }),
				),
			).success,
		).toBe(false);
	});

	it("renames defensive Search-input references carried by case operations", () => {
		const { doc, formUuid } = fixture();
		const form = doc.forms[formUuid] as Form;
		form.caseOperations = [
			createOperation({
				name: term(input("old_name")),
				condition: eq(input("old_name"), literal("enabled")),
			}),
		];

		expect(rewriteFormSearchInputRefs(form, "old_name", "new_name")).toBe(2);
		expect(form.caseOperations[0].name).toEqual(term(input("new_name")));
		expect(form.caseOperations[0].condition).toEqual(
			eq(input("new_name"), literal("enabled")),
		);
	});

	it("uses an old-receiver-safe updateForm extension while the writer gate is closed", () => {
		const legacyUpdateFormSchema = z.object({
			kind: z.literal("updateForm"),
			uuid: z.string(),
			patch: z.object({}).default({}),
		});
		const parsed = legacyUpdateFormSchema.parse({
			kind: "updateForm",
			uuid: "form-1",
			patch: {},
			caseOperationChange: {
				operation: "add",
				value: createOperation(),
			},
		});
		expect(parsed).toEqual({ kind: "updateForm", uuid: "form-1", patch: {} });
	});

	it("diffs add/update/move/remove as semantic updateForm extensions and replays over JSON", () => {
		const { doc: prev, formUuid } = fixture();
		const next = produce(prev, (draft) => {
			draft.forms[formUuid].caseOperations = [
				createOperation(),
				consumerOperation(),
			];
		});
		const addDiff = diffDocsToMutations(prev, next);
		expect(
			addDiff.filter(
				(mutation) =>
					mutation.kind === "updateForm" &&
					mutation.caseOperationChange !== undefined,
			),
		).toHaveLength(2);

		const parsed = JSON.parse(JSON.stringify(addDiff)).map(
			(mutation: unknown) => mutationSchema.parse(mutation),
		) as Mutation[];
		const replayed = apply(prev, parsed);
		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));

		const changed = produce(next, (draft) => {
			const operations = draft.forms[formUuid].caseOperations ?? [];
			operations[0].name = term(literal("Visit record"));
			operations.reverse();
		});
		const changeKinds = diffDocsToMutations(next, changed)
			.filter(
				(mutation) =>
					mutation.kind === "updateForm" &&
					(mutation.caseOperationPatch !== undefined ||
						mutation.caseOperationChange !== undefined),
			)
			.map(
				(mutation) =>
					mutation.kind === "updateForm" &&
					(mutation.caseOperationPatch?.operation ??
						mutation.caseOperationChange?.operation),
			);
		expect(changeKinds).toEqual(["update", "move"]);
		expect(
			diffDocsToMutations(next, changed).find(
				(mutation) =>
					mutation.kind === "updateForm" &&
					mutation.caseOperationPatch?.operation === "update",
			),
		).toMatchObject({
			caseOperationPatch: {
				operation: "update",
				uuid: CREATE,
				patch: { name: term(literal("Visit record")) },
			},
		});

		const removed = produce(changed, (draft) => {
			draft.forms[formUuid].caseOperations = [
				...(draft.forms[formUuid].caseOperations ?? []).slice(0, 1),
			];
		});
		expect(
			diffDocsToMutations(changed, removed).some(
				(mutation) =>
					mutation.kind === "updateForm" &&
					mutation.caseOperationChange?.operation === "remove",
			),
		).toBe(true);

		const reordered = produce(next, (draft) => {
			draft.forms[formUuid].caseOperations?.reverse();
		});
		const reorderDiff = diffDocsToMutations(next, reordered);
		expect(toPersistableDoc(apply(next, reorderDiff))).toEqual(
			toPersistableDoc(reordered),
		);
	});

	it("keeps stale update and move extensions reducer-no-op when identity is absent", () => {
		const { doc, formUuid } = fixture();
		const before = toPersistableDoc(doc);
		const after = apply(doc, [
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: {
					operation: "update",
					uuid: CREATE,
					value: createOperation({ id: "still_absent" }),
				},
				caseOperationPatch: {
					operation: "update",
					uuid: CREATE,
					patch: { id: "still_absent" },
				},
			},
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: {
					operation: "move",
					uuid: CREATE,
					after: null,
				},
			},
		]);
		expect(toPersistableDoc(after)).toEqual(before);
	});

	it("indexes every operation identity/expression edge and writer declaration", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [
			createOperation({ forEach: { repeat: REPEAT } }),
			consumerOperation({
				forEach: { repeat: REPEAT },
				condition: exists(subcasePath("parent", "visit")),
				writes: [
					{
						property: "source_id",
						value: term(prop("patient", "nickname")),
					},
					{ property: "form_name", value: term(formField(NAME)) },
					{ property: "created_id", value: idOf(CREATE) },
				],
				links: [
					{
						identifier: "parent",
						targetType: "patient",
						target: { kind: "session" },
						relationship: "child",
					},
				],
			}),
		];
		doc.refIndex = buildReferenceIndex(doc);

		expect(
			referencingSlotsOf(doc, entityTargetKey(CREATE)).get(formUuid),
		).toEqual(
			expect.arrayContaining([
				"case_operation_target_op",
				"case_operation_write_value",
			]),
		);
		expect(
			referencingSlotsOf(doc, entityTargetKey(REPEAT)).get(formUuid),
		).toContain("case_operation_repeat");
		expect(
			referencingSlotsOf(doc, entityTargetKey(NAME)).get(formUuid),
		).toContain("case_operation_write_value");
		expect(
			referencingSlotsOf(doc, caseTypeTargetKey("patient")).get(formUuid),
		).toEqual(expect.arrayContaining(["case_operation_link_target_type"]));
		expect(
			referencingSlotsOf(doc, caseTypeTargetKey("visit")).get(formUuid),
		).toContain("case_operation_condition");
		expect(
			referencingSlotsOf(doc, casePropertyTargetKey("patient", "nickname")).get(
				formUuid,
			),
		).toContain("case_operation_write_value");
		expect(
			referencingSlotsOf(doc, casePropertyTargetKey("visit", "source_id")).get(
				formUuid,
			),
		).toContain("case_operation_write_property");
		expect(declarersOf(doc, "visit", "source_id")).toContain(formUuid);
	});

	it("rewrites operation write keys and AST reads in the field/property rename cascade", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: CONSUMER,
				id: "copy_name",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					{
						property: "nickname",
						value: term(prop("patient", "nickname")),
					},
				],
			},
		];
		const next = apply(doc, [
			{ kind: "renameField", uuid: NAME, newId: "display_name" },
		]);
		const write = next.forms[formUuid].caseOperations?.[0].writes?.[0];
		expect(write?.property).toBe("display_name");
		expect(write?.value).toEqual(term(prop("patient", "display_name")));
		expect(next.refIndex).toEqual(buildReferenceIndex(next));
	});
});

// Writes and links are keyed collections, so pairing them up says nothing
// about their ORDER — that has to be compared separately, and it is intent
// like every other slot: honored when it differs from the snapshot the author
// saw, left alone when it does not.
describe("case-operation write and link order is intent", () => {
	function withWrites(properties: readonly string[]): CaseOperation {
		return {
			uuid: CONSUMER,
			id: "record_visit",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: properties.map((property) => ({
				property,
				value: term(literal(property)),
			})),
		};
	}

	function withLinks(identifiers: readonly string[]): CaseOperation {
		return {
			uuid: CONSUMER,
			id: "record_visit",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			links: identifiers.map((identifier) => ({
				identifier,
				targetType: "patient",
				target: null,
				relationship: "child" as const,
			})),
		};
	}

	function docHolding(operation: CaseOperation) {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [operation];
		return { doc, formUuid };
	}

	function committed(
		doc: BlueprintDoc,
		formUuid: ReturnType<typeof testUuid>,
		mutations: readonly Mutation[],
	): CaseOperation | undefined {
		return apply(doc, mutations).forms[formUuid].caseOperations?.find(
			(operation) => operation.uuid === CONSUMER,
		);
	}

	it("honors a reorder that arrives together with an addition", () => {
		// The regression: comparing the two arrays' LENGTHS made this reorder
		// invisible, because the addition changed the length. The tool then
		// reported success for an order it had silently discarded.
		const { doc, formUuid } = docHolding(withWrites(["alpha", "bravo"]));
		const plan = planCaseOperationUpdate(
			doc,
			formUuid,
			withWrites(["bravo", "alpha", "charlie"]),
			withWrites(["alpha", "bravo"]),
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(
			committed(doc, formUuid, plan.mutations)?.writes?.map(
				(write) => write.property,
			),
		).toEqual(["bravo", "alpha", "charlie"]);
	});

	it("leaves a peer's reorder alone when the author never touched the order", () => {
		const authorSaw = withWrites(["alpha", "bravo", "charlie"]);
		// The peer reordered while the author was editing alpha's value.
		const { doc, formUuid } = docHolding(
			withWrites(["charlie", "alpha", "bravo"]),
		);
		const desired = withWrites(["alpha", "bravo", "charlie"]);
		desired.writes = desired.writes?.map((write) =>
			write.property === "alpha"
				? { ...write, value: term(literal("edited")) }
				: write,
		);

		const plan = planCaseOperationUpdate(doc, formUuid, desired, authorSaw);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const result = committed(doc, formUuid, plan.mutations);
		expect(result?.writes?.map((write) => write.property)).toEqual([
			"charlie",
			"alpha",
			"bravo",
		]);
		expect(
			result?.writes?.find((write) => write.property === "alpha")?.value,
		).toEqual(term(literal("edited")));
	});

	it("leaves a peer's insertion where the peer put it while reordering around it", () => {
		// The author saw [alpha, bravo] and swapped them. Between the snapshot
		// and the dispatch a peer inserted charlie FIRST. The author's intent
		// permutes the two slots they could see; charlie is not theirs to move,
		// and appending it would be the clobber this whole rule prevents.
		const { doc, formUuid } = docHolding(
			withWrites(["charlie", "alpha", "bravo"]),
		);
		const plan = planCaseOperationUpdate(
			doc,
			formUuid,
			withWrites(["bravo", "alpha"]),
			withWrites(["alpha", "bravo"]),
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(
			committed(doc, formUuid, plan.mutations)?.writes?.map(
				(write) => write.property,
			),
		).toEqual(["charlie", "bravo", "alpha"]);
	});

	it("composes an add, a removal, a reorder, and a peer's insertion at once", () => {
		// Every moving part in one call. The author saw [alpha, bravo, charlie],
		// removed bravo, added delta, and ordered what was left [charlie,
		// delta, alpha]; a peer inserted echo at the FRONT meanwhile. Each half
		// has to survive whole: echo keeps index 0, and the author's order fills
		// the three slots their own members occupy.
		const { doc, formUuid } = docHolding(
			withWrites(["echo", "alpha", "bravo", "charlie"]),
		);
		const plan = planCaseOperationUpdate(
			doc,
			formUuid,
			withWrites(["charlie", "delta", "alpha"]),
			withWrites(["alpha", "bravo", "charlie"]),
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(
			committed(doc, formUuid, plan.mutations)?.writes?.map(
				(write) => write.property,
			),
		).toEqual(["echo", "charlie", "delta", "alpha"]);
	});

	it("honors a link reorder that arrives together with an addition", () => {
		const { doc, formUuid } = docHolding(withLinks(["parent", "sibling"]));
		const plan = planCaseOperationUpdate(
			doc,
			formUuid,
			withLinks(["sibling", "parent", "guardian"]),
			withLinks(["parent", "sibling"]),
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(
			committed(doc, formUuid, plan.mutations)?.links?.map(
				(link) => link.identifier,
			),
		).toEqual(["sibling", "parent", "guardian"]);
	});

	it("states its order unconditionally when the caller passes no snapshot", () => {
		// The tool surface has no snapshot, so `base` IS `current` there and
		// any order it states is intent by construction.
		const { doc, formUuid } = docHolding(
			withWrites(["alpha", "bravo", "charlie"]),
		);
		const mutations = updateCaseOperationMutations(
			doc,
			formUuid,
			withWrites(["charlie", "bravo", "alpha"]),
		);
		expect(
			committed(doc, formUuid, mutations)?.writes?.map(
				(write) => write.property,
			),
		).toEqual(["charlie", "bravo", "alpha"]);
	});
});
