import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	addCaseOperationMutations,
	caseOperationEditVerdict,
	moveCaseOperationMutation,
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
import { asUuid, type Mutation, mutationSchema } from "@/lib/doc/types";
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

const CREATE = asUuid("11111111-1111-4111-8111-111111111111");
const CONSUMER = asUuid("22222222-2222-4222-8222-222222222222");
const OTHER = asUuid("33333333-3333-4333-8333-333333333333");
const NAME = asUuid("44444444-4444-4444-8444-444444444444");
const REPEAT = asUuid("55555555-5555-4555-8555-555555555555");

function fixture(): {
	doc: BlueprintDoc;
	formUuid: ReturnType<typeof asUuid>;
} {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "nickname", label: "Nickname" }],
			},
			{
				name: "visit",
				properties: [{ name: "source_id", label: "Source ID" }],
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
		order: "a",
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
		order: "b",
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

	it("preserves the existing order when an update omits it", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [createOperation()];
		const mutations = updateCaseOperationMutations(doc, formUuid, {
			...createOperation(),
			order: undefined,
			name: term(literal("Renamed")),
		});
		const next = apply(doc, mutations);
		expect(next.forms[formUuid].caseOperations?.[0].order).toBe("a");
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

	it("rejects removal and reordering while later references depend on a create", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [
			createOperation(),
			consumerOperation(),
		];

		expect(removeCaseOperationMutation(doc, formUuid, CREATE)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependentUuids: [CONSUMER],
		});
		expect(moveCaseOperationMutation(doc, formUuid, CREATE, 1)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependentUuids: [CONSUMER],
		});
		expect(moveCaseOperationMutation(doc, formUuid, CONSUMER, 0)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependentUuids: [CONSUMER],
		});
	});

	it("treats an ordered retype as a dependency of later same-target operations", () => {
		const { doc, formUuid } = fixture();
		const retype: CaseOperation = {
			uuid: CONSUMER,
			id: "retype_visit",
			order: "b",
			action: "update",
			caseType: "visit",
			target: { kind: "op", opUuid: CREATE },
			retype: "patient",
		};
		const later: CaseOperation = {
			uuid: OTHER,
			id: "update_retyped_visit",
			order: "c",
			action: "update",
			caseType: "patient",
			target: { kind: "op", opUuid: CREATE },
		};
		(doc.forms[formUuid] as Form).caseOperations = [
			createOperation(),
			retype,
			later,
		];

		expect(removeCaseOperationMutation(doc, formUuid, CONSUMER)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependentUuids: [OTHER],
		});
		expect(moveCaseOperationMutation(doc, formUuid, CONSUMER, 2)).toEqual({
			ok: false,
			reason: "dependent-reference",
			dependentUuids: [OTHER],
		});
	});

	it("rejects a move that introduces a possible runtime alias after retype", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: CONSUMER,
				id: "update_runtime_patient",
				order: "a",
				action: "update",
				caseType: "patient",
				target: { kind: "expression", expr: term(formField(NAME)) },
			},
			{
				uuid: OTHER,
				id: "retype_session_patient",
				order: "b",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				retype: "visit",
			},
		];

		expect(moveCaseOperationMutation(doc, formUuid, OTHER, 0)).toEqual({
			ok: false,
			reason: "dependent-reference",
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
				order: "c",
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
			next.forms[formUuid].caseOperations?.find((op) => op.uuid === OTHER)
				?.order,
		).toBeDefined();
		expect(
			orderedCaseOperations(next.forms[formUuid]).map(
				(operation) => operation.uuid,
			),
		).toEqual([OTHER, CREATE, CONSUMER]);
	});

	it("does not rewrite a fractional key for an already-placed operation", () => {
		const { doc, formUuid } = fixture();
		const current = createOperation({ order: "a" });
		(doc.forms[formUuid] as Form).caseOperations = [
			current,
			consumerOperation({ order: "c" }),
		];

		expect(moveCaseOperationMutation(doc, formUuid, current.uuid, 0)).toEqual({
			ok: true,
			mutations: [],
		});
		expect(
			doc.forms[formUuid].caseOperations?.find(
				(operation) => operation.uuid === current.uuid,
			)?.order,
		).toBe("a");
	});

	it("rejects a move across multiplicity scopes when the wire cannot preserve it", () => {
		const { doc, formUuid } = fixture();
		(doc.forms[formUuid] as Form).caseOperations = [
			{
				uuid: OTHER,
				id: "update_patient",
				order: "a",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
			},
			createOperation({ order: "b", forEach: { repeat: REPEAT } }),
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
			order: "b",
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
			order: "a",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			retype: "visit",
		};
		const later: CaseOperation = {
			uuid: OTHER,
			id: "update_visit",
			order: "b",
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
			order: "b",
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
			order: "a",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
		};
		const generated = createOperation({ order: "b" });
		(doc.forms[formUuid] as Form).caseOperations = [earlier, generated];

		expect(caseOperationEditVerdict(doc, formUuid, generated)).toEqual({
			ok: true,
		});
		expect(
			caseOperationEditVerdict(doc, formUuid, {
				...generated,
				target: { kind: "new", idFrom: NAME },
			}),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("follows a non-create effect"),
		});
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
			operations[1].order = "z";
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

		const orderCleared = produce(next, (draft) => {
			const operation = draft.forms[formUuid].caseOperations?.[0];
			if (operation !== undefined) delete operation.order;
		});
		const clearDiff = diffDocsToMutations(next, orderCleared);
		expect(toPersistableDoc(apply(next, clearDiff))).toEqual(
			toPersistableDoc(orderCleared),
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
					order: "z",
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
