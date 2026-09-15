import { describe, expect, it } from "vitest";
import {
	buildPlanSchema,
	buildPlanSchemaFor,
	deriveBuildPlan as deriveAdmittedBuildPlan,
	newPlanAdmissionMessages,
} from "@/lib/agent/design/buildPlan";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import { computeLookupChoiceProjectionAttestation } from "@/lib/agent/design/lookupChoiceAttestation";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { lookupRevisionSchema } from "@/lib/lookup/schema";
import {
	addPatientReviewWorkflow,
	cloneContract,
	did,
	fixtureValue,
	ids,
	makeBuildPlan,
	makeContract,
	makeNestedMenuContract,
	makeThirteenWorkflowContract,
	makeWorkflowChainContract,
} from "./fixtures";

const EXISTING_TABLE_ID = lookupTableIdSchema.parse(
	"018f0000-0000-7000-8000-000000000001",
);
const EXISTING_VALUE_COLUMN_ID = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-000000000002",
);
const EXISTING_LABEL_COLUMN_ID = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-000000000003",
);
const EXISTING_ROW_ID = lookupRowIdSchema.parse(
	"018f0000-0000-7000-8000-000000000004",
);
const EXISTING_SECOND_ROW_ID = lookupRowIdSchema.parse(
	"018f0000-0000-7000-8000-000000000005",
);

function deriveBuildPlan(args: Parameters<typeof deriveAdmittedBuildPlan>[0]) {
	return deriveAdmittedBuildPlan({
		...args,
		contract: appDesignContractSchema.parse(args.contract),
	});
}

function messages(
	result: ReturnType<typeof buildPlanSchema.safeParse>,
): string {
	return result.success
		? ""
		: result.error.issues.map((issue) => issue.message).join("\n");
}

function childFormBeforeItsHome(childIndex = 1) {
	const contract = cloneContract(makeWorkflowChainContract(3));
	for (const workflow of contract.workflows) {
		workflow.startingConditions = [];
	}
	const parent = fixtureValue(contract.moduleCompositions[2], "parent module");
	const child = fixtureValue(
		contract.moduleCompositions[childIndex],
		"child module",
	);
	const record = fixtureValue(contract.records[childIndex], "child record");
	const property = fixtureValue(record.properties[0], "child property");
	const list = {
		...fixtureValue(makeContract().lists[0], "list"),
		id: did(9005),
		actorIds: child.actorIds,
		recordId: record.id,
		scanPropertyIds: [property.id],
		detailPropertyIds: [property.id],
		searchPropertyIds: [],
	};
	child.role = "form-and-queue";
	child.parentModuleCompositionId = parent.id;
	child.listIds = [list.id];
	contract.lists.push(list);
	contract.moduleCompositions = [
		...contract.moduleCompositions.filter(
			(module) => module !== parent && module !== child,
		),
		parent,
		child,
	];
	return contract;
}

describe("deterministic build planning", () => {
	it("builds the parent before a delayed home and keeps the home with its form", () => {
		const contract = childFormBeforeItsHome();
		const menuOrder = contract.moduleCompositions.map((module) => module.id);
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		expect(plan.slices.map((slice) => slice.workflowId)).toEqual([
			did(3000),
			did(3002),
			did(3001),
		]);
		const homeSlice = fixtureValue(plan.slices[1], "home slice");
		const formSlice = fixtureValue(plan.slices[2], "form slice");
		expect(
			homeSlice.constructionGroups.flatMap((group) => group.elements),
		).toEqual(
			expect.arrayContaining([{ kind: "module-composition", id: did(4002) }]),
		);
		expect(formSlice.prerequisiteSliceIds).toContain(homeSlice.id);
		expect(
			formSlice.constructionGroups.flatMap((group) => group.elements),
		).toContainEqual({ kind: "form-composition", id: did(5001) });
		expect(
			formSlice.constructionGroups.flatMap((group) => group.elements),
		).toEqual(
			expect.arrayContaining([
				{ kind: "module-composition", id: did(4001) },
				{ kind: "list", id: did(9005) },
			]),
		);
		expect(contract.moduleCompositions.map((module) => module.id)).toEqual(
			menuOrder,
		);
	});

	it("rejects an initial workflow that needs a later module even without a cycle", () => {
		const result = appDesignContractSchema.safeParse(childFormBeforeItsHome(0));
		expect(result.success).toBe(false);
		if (result.success)
			throw new Error("Expected an initial workflow dependency");
		expect(result.error.issues.map((issue) => issue.message)).toContain(
			"The initial workflow must not depend on another workflow to construct its module or forms.",
		);
	});

	it("does not require a viewer before an explicit create of an unrelated record", () => {
		const contract = makeWorkflowChainContract(2);
		const [first, later] = contract.workflows;
		first.recordEffects.push({
			...later.recordEffects[0],
			handle: "create_unrelated",
			writes: [],
		});
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
		});
		const root = plan.slices[0];
		expect(root.workflowId).toBe(first.id);
		expect(root.prerequisiteSliceIds).toEqual([]);
		expect(
			root.constructionGroups
				.flatMap((group) => group.elements)
				.filter((element) => element.kind === "module-composition"),
		).toEqual([
			{ kind: "module-composition", id: contract.moduleCompositions[0].id },
		]);
	});

	it.each([false, true])(
		"uses a feasible form viewer when a later list would cause a cycle (later form: %s)",
		(laterForm) => {
			const contract = makeWorkflowChainContract(3);
			const [related, parent] = contract.records;
			const [registration, writer, edit] = contract.workflows;
			const [relatedHome, parentHome, editHome] = contract.moduleCompositions;
			const editForm = contract.formCompositions[2];
			related.parentRecordId = parent.id;
			related.relationshipMeaning =
				"Each related record belongs to its parent.";
			contract.records = [related, parent];
			writer.recordEffects.push({
				handle: "create_related",
				recordId: related.id,
				kind: "create",
				writes: [],
				outcome: "A related record is saved.",
			});
			const secondActor = {
				...contract.actors[0],
				id: did(9700),
				name: "Second actor",
			};
			contract.actors.push(secondActor);
			edit.contextRecordId = parent.id;
			edit.actorIds.push(secondActor.id);
			edit.inputs[0].propertyId = parent.properties[0].id;
			edit.recordEffects[0].kind = "update";
			edit.recordEffects[0].recordId = parent.id;
			edit.recordEffects[0].writes[0].propertyId = parent.properties[0].id;
			edit.readback = [
				{
					recordId: parent.id,
					purpose: "Review the parent",
					propertyIds: [parent.properties[0].id],
				},
			];
			editHome.hostRecordId = parent.id;
			editHome.actorIds = [secondActor.id];
			editForm.mode = "selected-record";
			editForm.variant = "actor-specific";
			editForm.actorIds = [secondActor.id];
			editForm.duplicateRationale = "Second actor edits from their own menu.";
			const otherForm = structuredClone(editForm);
			otherForm.id = did(9701);
			otherForm.moduleCompositionId = parentHome.id;
			otherForm.actorIds = [contract.actors[0].id];
			if (otherForm.layout.kind !== "flat")
				throw new Error("Expected the fixture's flat form layout");
			otherForm.layout.items[0].id = did(9702);
			otherForm.duplicateRationale =
				"First actor edits from their existing menu.";
			contract.formCompositions.push(otherForm);
			parentHome.workflowIds.push(edit.id);
			const list = {
				...makeContract().lists[0],
				id: did(9703),
				name: "Related records",
				actorIds: [secondActor.id],
				recordId: related.id,
				scanPropertyIds: [related.properties[0].id],
				detailPropertyIds: [],
				searchPropertyIds: [],
			};
			contract.lists = [list];
			const laterView = {
				...structuredClone(relatedHome),
				id: did(9704),
				name: "Related records for second actor",
				role: "queue-only" as const,
				workflowIds: [edit.id],
				actorIds: [secondActor.id],
				listIds: [list.id],
				parentModuleCompositionId: editHome.id,
			};
			contract.moduleCompositions.push(laterView);
			if (laterForm) {
				const neutral = makeWorkflowChainContract(4);
				const starter = neutral.workflows[3];
				contract.records.push(neutral.records[3]);
				contract.moduleCompositions.push(neutral.moduleCompositions[3]);
				contract.formCompositions.push(neutral.formCompositions[3]);
				contract.workflows = [starter, writer, registration, edit];
				contract.charter.initialWorkflowId = starter.id;
				contract.charter.includedWorkflowIds = contract.workflows.map(
					(workflow) => workflow.id,
				);
			}
			const plan = deriveBuildPlan({
				contract,
				revision: { id: ids.revisionId, digest: "1".repeat(64) },
			});
			expect(plan.slices.map((slice) => slice.workflowId)).toEqual([
				...(laterForm ? [contract.charter.initialWorkflowId] : []),
				registration.id,
				writer.id,
				edit.id,
			]);
			const writerSlice = fixtureValue(
				plan.slices.find((slice) => slice.workflowId === writer.id),
				"writer slice",
			);
			const editSlice = fixtureValue(
				plan.slices.find((slice) => slice.workflowId === edit.id),
				"edit slice",
			);
			expect(writerSlice.prerequisiteSliceIds).not.toContain(editSlice.id);
			expect(
				editSlice.constructionGroups.flatMap((group) => group.elements),
			).toContainEqual({
				kind: "module-composition",
				id: laterView.id,
			});
		},
	);

	it.each([
		{ reverseRecords: false, secondRegistration: false },
		{ reverseRecords: true, secondRegistration: false },
		{ reverseRecords: false, secondRegistration: true },
		{ reverseRecords: true, secondRegistration: true },
	])(
		"schedules sibling writers independently of record order: %j",
		({ reverseRecords, secondRegistration }) => {
			const contract = makeWorkflowChainContract(4);
			const [neutral, parent, related, sibling] = contract.records;
			const [initial, firstWriter, secondWriter, registration] =
				contract.workflows;
			const [neutralHome, firstHome, secondHome, relatedHome] =
				contract.moduleCompositions;
			for (const child of [related, sibling]) {
				child.parentRecordId = parent.id;
				child.relationshipMeaning = "Each child belongs to its parent.";
			}
			firstWriter.recordEffects.push({
				handle: "create_related",
				recordId: related.id,
				kind: "create",
				writes: [],
				outcome: "Save the related record.",
			});
			secondWriter.inputs[0].propertyId = parent.properties[0].id;
			secondWriter.recordEffects[0].recordId = parent.id;
			secondWriter.recordEffects[0].writes[0].propertyId =
				parent.properties[0].id;
			secondWriter.readback = [
				{
					recordId: parent.id,
					purpose: "Review the parent",
					propertyIds: [parent.properties[0].id],
				},
			];
			secondWriter.recordEffects.push({
				handle: "create_sibling",
				recordId: sibling.id,
				kind: "create",
				writes: [],
				outcome: "Save the sibling record.",
			});
			secondHome.hostRecordId = parent.id;
			if (!secondRegistration) {
				secondWriter.contextRecordId = parent.id;
				secondWriter.recordEffects[0].kind = "update";
				contract.formCompositions[2].mode = "selected-record";
			}
			registration.inputs[0].propertyId = related.properties[0].id;
			registration.recordEffects[0].recordId = related.id;
			registration.recordEffects[0].writes[0].propertyId =
				related.properties[0].id;
			registration.readback = [
				{
					recordId: related.id,
					purpose: "Review related records",
					propertyIds: [related.properties[0].id],
				},
			];
			relatedHome.hostRecordId = related.id;
			const relatedList = {
				...makeContract().lists[0],
				id: did(9800),
				recordId: related.id,
				actorIds: contract.actors.map((actor) => actor.id),
				scanPropertyIds: [related.properties[0].id],
				detailPropertyIds: [],
				searchPropertyIds: [],
			};
			const siblingList = {
				...relatedList,
				id: did(9801),
				recordId: sibling.id,
				scanPropertyIds: [sibling.properties[0].id],
			};
			contract.lists = [relatedList, siblingList];
			const relatedView = {
				...structuredClone(relatedHome),
				id: did(9802),
				role: "queue-only" as const,
				workflowIds: [secondWriter.id],
				listIds: [relatedList.id],
				parentModuleCompositionId: secondHome.id,
			};
			const siblingView = {
				...relatedView,
				id: did(9803),
				hostRecordId: sibling.id,
				workflowIds: [firstWriter.id],
				listIds: [siblingList.id],
				parentModuleCompositionId: firstHome.id,
			};
			contract.moduleCompositions = [
				neutralHome,
				firstHome,
				siblingView,
				secondHome,
				relatedView,
				relatedHome,
			];
			contract.records = [
				...(reverseRecords ? [sibling, related] : [related, sibling]),
				parent,
				neutral,
			];
			const plan = deriveBuildPlan({
				contract,
				revision: { id: ids.revisionId, digest: "1".repeat(64) },
			});
			expect(plan.slices.map((slice) => slice.workflowId)).toEqual([
				initial.id,
				registration.id,
				firstWriter.id,
				secondWriter.id,
			]);
			const beforeWriter = fixtureValue(
				plan.slices.find((slice) => slice.workflowId === registration.id),
				"independent registration",
			);
			const first = fixtureValue(
				plan.slices.find((slice) => slice.workflowId === firstWriter.id),
				"first writer",
			);
			const second = fixtureValue(
				plan.slices.find((slice) => slice.workflowId === secondWriter.id),
				"second writer",
			);
			expect(first.prerequisiteSliceIds).toContain(beforeWriter.id);
			expect(second.prerequisiteSliceIds).toContain(first.id);
			expect(first.prerequisiteSliceIds).not.toContain(second.id);
		},
	);

	it("establishes a shared child list with the writer whose menu is ready first", () => {
		const contract = makeWorkflowChainContract(3);
		const [, parent, child] = contract.records;
		const [initial, laterWriter, firstWriter] = contract.workflows;
		const [neutralHome, laterHome, firstHome] = contract.moduleCompositions;
		child.parentRecordId = parent.id;
		child.relationshipMeaning = "Each child belongs to its parent.";
		firstWriter.inputs[0].propertyId = parent.properties[0].id;
		firstWriter.recordEffects[0].recordId = parent.id;
		firstWriter.recordEffects[0].writes[0].propertyId = parent.properties[0].id;
		firstWriter.readback = [
			{
				recordId: parent.id,
				purpose: "Review the parent",
				propertyIds: [parent.properties[0].id],
			},
		];
		firstHome.hostRecordId = parent.id;
		laterHome.parentModuleCompositionId = firstHome.id;
		for (const writer of [laterWriter, firstWriter])
			writer.recordEffects.push({
				handle: "create_child",
				recordId: child.id,
				kind: "create",
				writes: [],
				outcome: "Save a child with its parent.",
			});
		const list = {
			...makeContract().lists[0],
			id: did(9900),
			recordId: child.id,
			actorIds: contract.actors.map((actor) => actor.id),
			scanPropertyIds: [child.properties[0].id],
			detailPropertyIds: [],
			searchPropertyIds: [],
		};
		contract.lists = [list];
		const childHome = {
			...firstHome,
			id: did(9901),
			hostRecordId: child.id,
			role: "queue-only" as const,
			workflowIds: [laterWriter.id],
			listIds: [list.id],
		};
		contract.moduleCompositions = [
			neutralHome,
			firstHome,
			laterHome,
			childHome,
		];
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
		});
		expect(plan.slices.map((slice) => slice.workflowId)).toEqual([
			initial.id,
			firstWriter.id,
			laterWriter.id,
		]);
		const first = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === firstWriter.id),
			"first ready writer",
		);
		expect(
			first.constructionGroups.flatMap((group) => group.elements),
		).toContainEqual({ kind: "module-composition", id: childHome.id });
	});

	it("builds a record catalog for its first consumer while preserving worker starting conditions", () => {
		const contract = makeContract();
		contract.charter.initialWorkflowId = ids.taskVisit;
		const before = structuredClone(contract);
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
		});
		expect(plan.slices.map((slice) => slice.workflowId)).toEqual([
			ids.taskVisit,
			ids.taskRegister,
		]);
		const first = plan.slices[0];
		expect(first.constructionGroups.flatMap((group) => group.elements)).toEqual(
			expect.arrayContaining([
				{ kind: "record", id: ids.recPatient },
				{ kind: "record", id: ids.recVisit },
			]),
		);
		expect(first.prerequisiteSliceIds).toEqual([]);
		expect(plan.slices[1].prerequisiteSliceIds).toEqual([first.id]);
		expect(contract).toEqual(before);
		expect(contract.workflows[1].startingConditions).not.toHaveLength(0);
	});

	it("derives one dependency-ordered slice per workflow", () => {
		const plan = makeBuildPlan();
		expect(plan.schemaVersion).toBe(1);
		expect(plan.lookupMaterialization).toBeNull();
		expect(plan.slices.map((slice) => slice.workflowId)).toEqual([
			ids.taskRegister,
			ids.taskVisit,
		]);
		expect(plan.slices[0]?.role).toBe("materialization-root");
		expect(plan.slices[1]?.prerequisiteSliceIds).toEqual([plan.slices[0]?.id]);
	});

	it("schedules one module selection realization after every affected workflow", () => {
		const contract = cloneContract(makeContract());
		addPatientReviewWorkflow(contract);
		fixtureValue(contract.moduleCompositions[0], "patient module").selection = {
			cases: "several",
			maximum: 12,
		};
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const registration = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskRegister),
			"registration slice",
		);
		const visit = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskVisit),
			"visit slice",
		);
		const review = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskReview),
			"review slice",
		);

		expect(review.prerequisiteSliceIds).toEqual([registration.id, visit.id]);
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(true);
	});

	it("adds the parent owner as the child module owner's prerequisite", () => {
		const contract = makeNestedMenuContract();
		const childWorkflow = fixtureValue(
			contract.workflows.find((workflow) => workflow.id === ids.taskVisit),
			"child workflow",
		);

		childWorkflow.startingConditions = [];
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const parentSlice = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskRegister),
			"parent owner slice",
		);
		const childSlice = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === ids.taskVisit),
			"child owner slice",
		);
		expect(parentSlice.role).toBe("materialization-root");
		expect(parentSlice.prerequisiteSliceIds).toEqual([]);
		expect(childSlice.prerequisiteSliceIds).toContain(parentSlice.id);
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(true);
	});

	it("adds a different-record parent's first form owner as a prerequisite", () => {
		const contract = cloneContract(makeThirteenWorkflowContract());
		for (const workflow of contract.workflows) {
			workflow.startingConditions = [];
		}
		const parent = fixtureValue(
			contract.moduleCompositions[0],
			"parent module",
		);
		const displaced = fixtureValue(
			contract.moduleCompositions[1],
			"displaced root module",
		);
		const child = fixtureValue(contract.moduleCompositions[2], "child module");
		const parentOwner = fixtureValue(contract.workflows[0], "parent owner");
		const parentFormOwner = fixtureValue(
			contract.workflows[1],
			"parent form owner",
		);
		const childOwner = fixtureValue(contract.workflows[2], "child owner");
		const parentOwnerForm = fixtureValue(
			contract.formCompositions[0],
			"parent owner form",
		);
		const parentForm = fixtureValue(
			contract.formCompositions[1],
			"later parent form",
		);
		parent.workflowIds = [parentOwner.id, parentFormOwner.id];
		parent.role = "form-and-queue";
		const parentList = {
			...makeContract().lists[0],
			id: did(890),
			recordId: fixtureValue(parent.hostRecordId, "parent record"),
			actorIds: parent.actorIds,
			scanPropertyIds: [],
			detailPropertyIds: [],
			searchPropertyIds: [],
		};
		contract.lists.push(parentList);
		parent.listIds = [parentList.id];
		parentForm.mode = "selected-record";
		parentFormOwner.contextRecordId = parent.hostRecordId;
		parent.selection = { cases: "one" };
		delete displaced.hostRecordId;
		parentOwnerForm.mode = "standalone";
		parentForm.moduleCompositionId = parent.id;
		parentOwnerForm.moduleCompositionId = displaced.id;
		displaced.workflowIds = [parentOwner.id, parentFormOwner.id];
		child.parentModuleCompositionId = parent.id;
		contract.moduleCompositions.splice(0, 3, parent, child, displaced);

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const childSlice = fixtureValue(
			plan.slices.find((slice) => slice.workflowId === childOwner.id),
			"child slice",
		);
		const prerequisites = childSlice.prerequisiteSliceIds.map(
			(id) => plan.slices.find((slice) => slice.id === id)?.workflowId,
		);
		expect(prerequisites).toEqual([parentFormOwner.id]);
		expect(
			plan.slices
				.find((slice) => slice.workflowId === parentFormOwner.id)
				?.constructionGroups.flatMap((group) => group.elements),
		).toContainEqual({
			kind: "module-composition",
			id: parent.id,
		});
	});

	it.each([false, true])(
		"schedules a child viewer before its writer when its own form is later: %s",
		(laterForm) => {
			const contract = cloneContract(makeThirteenWorkflowContract());
			for (const workflow of contract.workflows) {
				workflow.startingConditions = [];
			}
			const parent = fixtureValue(
				contract.moduleCompositions[0],
				"parent module",
			);
			const child = fixtureValue(
				contract.moduleCompositions[1],
				"child module",
			);
			const parentOwner = fixtureValue(contract.workflows[0], "parent owner");
			const childOwner = fixtureValue(contract.workflows[1], "child owner");
			const writer = fixtureValue(contract.workflows[2], "parent form writer");
			const writerForm = fixtureValue(
				contract.formCompositions[2],
				"parent form writer composition",
			);
			const childRecord = fixtureValue(
				contract.records.find((record) => record.id === child.hostRecordId),
				"child record",
			);
			const childProperty = fixtureValue(
				childRecord.properties[0],
				"child property",
			);
			const writerEffect = fixtureValue(
				writer.recordEffects[0],
				"writer create effect",
			);
			const writerWrite = fixtureValue(writerEffect.writes[0], "writer value");
			parent.workflowIds = [parentOwner.id, writer.id];
			child.parentModuleCompositionId = parent.id;
			writerForm.moduleCompositionId = parent.id;
			writerForm.mode = "selected-record";
			writer.contextRecordId = parent.hostRecordId;
			parent.selection = { cases: "one" };
			contract.moduleCompositions.splice(2, 1);
			writerEffect.recordId = fixtureValue(
				child.hostRecordId,
				"child host record",
			);
			writerWrite.propertyId = childProperty.id;
			childRecord.parentRecordId = fixtureValue(
				parent.hostRecordId,
				"parent record",
			);
			childRecord.relationshipMeaning =
				"Each child record belongs to its selected parent.";
			if (laterForm) {
				contract.workflows.splice(1, 2, writer, childOwner);
				child.role = "form-and-queue";
				const list = {
					...fixtureValue(makeContract().lists[0], "list"),
					id: did(9001),
					actorIds: child.actorIds,
					recordId: childRecord.id,
					scanPropertyIds: [childProperty.id],
					detailPropertyIds: [childProperty.id],
					searchPropertyIds: [],
				};
				child.listIds = [list.id];
				contract.lists.push(list);
			}

			const plan = deriveBuildPlan({
				contract,
				revision: { id: ids.revisionId, digest: "1".repeat(64) },
				planId: ids.planId,
			});
			const writerSlice = fixtureValue(
				plan.slices.find((slice) => slice.workflowId === writer.id),
				"writer slice",
			);
			const prerequisites = writerSlice.prerequisiteSliceIds.map(
				(id) => plan.slices.find((slice) => slice.id === id)?.workflowId,
			);
			if (laterForm) {
				expect(prerequisites).not.toContain(childOwner.id);
				const owned = writerSlice.constructionGroups.flatMap(
					(group) => group.elements,
				);
				expect(owned).toEqual(
					expect.arrayContaining([
						{ kind: "module-composition", id: child.id },
						{ kind: "list", id: did(9001) },
					]),
				);
				const laterSlice = fixtureValue(
					plan.slices.find((slice) => slice.workflowId === childOwner.id),
					"later form slice",
				);
				expect(laterSlice.prerequisiteSliceIds).toContain(writerSlice.id);
				expect(
					laterSlice.constructionGroups.flatMap((group) => group.elements),
				).not.toContainEqual({ kind: "module-composition", id: child.id });
				expect(child.workflowIds).toEqual([childOwner.id]);
			} else {
				expect(prerequisites).toContain(childOwner.id);
			}
		},
	);

	it("does not create workflow prerequisites from sibling placement", () => {
		const contract = makeThirteenWorkflowContract();
		for (const workflow of contract.workflows) {
			workflow.startingConditions = [];
		}
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const first = fixtureValue(plan.slices[0], "first module owner slice");
		const second = fixtureValue(plan.slices[1], "second module owner slice");
		const third = fixtureValue(plan.slices[2], "third module owner slice");

		expect(first.role).toBe("materialization-root");
		expect(first.prerequisiteSliceIds).toEqual([]);
		expect(second.prerequisiteSliceIds).toEqual([]);
		expect(third.prerequisiteSliceIds).toEqual([]);
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(true);
	});

	it("is stable for the same accepted revision", () => {
		const first = makeBuildPlan();
		const second = makeBuildPlan();
		expect(second).toEqual(first);
	});

	it("owns the complete registration and visit construction, including shared catalog and queue work", () => {
		const contract = makeContract();
		const before = structuredClone(contract);
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			planId: ids.planId,
		});
		const e = (kind: string, ...elementIds: string[]) =>
			elementIds.map((id) => ({ kind, id }));
		expect(
			plan.slices.map((slice) => ({
				workflowId: slice.workflowId,
				role: slice.role,
				groups: slice.constructionGroups.map(
					({ kind, elements, blueprintAreas }) => ({
						kind,
						elements,
						blueprintAreas,
					}),
				),
			})),
		).toEqual([
			{
				workflowId: ids.taskRegister,
				role: "materialization-root",
				groups: [
					{
						kind: "foundation",
						elements: [
							...e("actor", ids.actorChw, ids.actorSupervisor),
							...e("record", ids.recPatient),
							...e("property", ids.factName, ids.factAge, ids.factRisk),
						],
						blueprintAreas: ["case-catalog", "users"],
					},
					{
						kind: "workflow",
						elements: [
							...e("workflow", ids.taskRegister),
							...e("form-composition", ids.formRegister),
							...e("composition-section", ids.sectionRegisterIdentity),
							...e("composition-item", ids.itemRegisterName),
							...e("composition-section", ids.sectionRegisterTriage),
							...e(
								"composition-item",
								ids.itemRegisterGuidance,
								ids.itemRegisterAge,
							),
						],
						blueprintAreas: ["app", "forms", "media-references"],
					},
					{
						kind: "work-queue",
						elements: e("list", ids.rmPatients),
						blueprintAreas: ["case-list"],
					},
					{
						kind: "access-navigation",
						elements: [
							...e("access", ids.accessSupervisor),
							...e("module-composition", ids.modulePatients),
						],
						blueprintAreas: ["navigation", "media-references", "users"],
					},
				],
			},
			{
				workflowId: ids.taskVisit,
				role: "ordinary",
				groups: [
					{
						kind: "foundation",
						elements: [
							...e("record", ids.recVisit),
							...e("property", ids.factVisitSummary),
						],
						blueprintAreas: ["case-catalog"],
					},
					{
						kind: "workflow",
						elements: [
							...e("workflow", ids.taskVisit),
							...e("form-composition", ids.formVisit),
							...e("composition-section", ids.sectionVisit),
							...e("composition-item", ids.itemVisitSummary),
						],
						blueprintAreas: ["forms", "case-operations", "media-references"],
					},
				],
			},
		]);
		expect(contract).toEqual(before);
		expect(
			deriveBuildPlan({
				contract: JSON.parse(JSON.stringify(contract)),
				revision: { id: ids.revisionId, digest: "b".repeat(64) },
				planId: ids.planId,
			}),
		).toEqual(plan);
	});

	it("derives thirteen exact workflow slices with unique construction ownership", () => {
		const contract = makeThirteenWorkflowContract();
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		expect(plan.slices).toHaveLength(13);
		expect(plan.slices.map((slice) => slice.workflowId)).toEqual(
			contract.charter.includedWorkflowIds,
		);
		const owned = plan.slices.flatMap((slice) =>
			slice.constructionGroups.flatMap((group) =>
				group.elements.map((element) => `${element.kind}:${element.id}`),
			),
		);
		expect(new Set(owned).size).toBe(owned.length);
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(true);
	});

	it("puts the materialization root first and gives it the only app-area owner", () => {
		const contract = makeWorkflowChainContract(2);
		contract.records = [];
		contract.workflows.forEach((workflow, index) => {
			workflow.startingConditions = [];
			workflow.inputs = [
				{
					handle: `workflow_${index + 1}_value`,
					name: "Answer",
					purpose: "Collect a standalone response",
					dataShape: "text",
				},
			];
			workflow.recordEffects = [];
			workflow.readback = [];
		});
		for (const module of contract.moduleCompositions)
			delete module.hostRecordId;
		for (const form of contract.formCompositions) form.mode = "standalone";
		contract.charter.initialWorkflowId = contract.workflows[1].id;
		contract.moduleCompositions.reverse();

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "9".repeat(64) },
			planId: ids.planId,
		});
		expect(plan.slices[0]?.workflowId).toBe(contract.workflows[1].id);
		expect(plan.slices[0]?.role).toBe("materialization-root");
		const appOwners = plan.slices.flatMap((slice) =>
			slice.constructionGroups
				.filter((group) => group.blueprintAreas.includes("app"))
				.map((group) => ({ slice, group })),
		);
		expect(appOwners).toHaveLength(1);
		expect(appOwners[0]?.slice.role).toBe("materialization-root");
		expect(appOwners[0]?.group.kind).toBe("workflow");
	});

	it("keeps generic reads permissive while enforcing exact app ownership for derived plans", () => {
		const contract = makeContract();
		const plan = makeBuildPlan();
		const laterGroup = plan.slices
			.slice(1)
			.flatMap((slice) => slice.constructionGroups)
			.find((group) => !group.blueprintAreas.includes("app"));
		if (laterGroup === undefined)
			throw new Error("fixture needs a later group");
		laterGroup.blueprintAreas.push("app");

		expect(buildPlanSchema.safeParse(plan).success).toBe(true);
		expect(buildPlanSchemaFor(contract).safeParse(plan).success).toBe(false);
	});

	it("derives media and automation areas from explicit workflow semantics", () => {
		const contract = cloneContract(makeContract());
		const workflow = contract.workflows[0];
		if (workflow === undefined) throw new Error("fixture workflow missing");
		workflow.authoredFeatures = ["existing-media", "automation"];
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const group = plan.slices[0]?.constructionGroups.find((candidate) =>
			candidate.elements.some((element) => element.kind === "workflow"),
		);
		expect(group?.blueprintAreas).toEqual(
			expect.arrayContaining(["media-references", "automations"]),
		);
	});

	it("mounts case operations for a single effect targeting a non-context record", () => {
		const contract = cloneContract(makeContract());
		const workflow = contract.workflows.find(
			(candidate) => candidate.id === ids.taskVisit,
		);
		if (workflow === undefined) throw new Error("visit workflow missing");
		const effect = workflow.recordEffects[0];
		if (effect === undefined) throw new Error("visit effect missing");
		delete effect.sourceRecordId;
		expect(effect.recordId).not.toBe(workflow.contextRecordId);

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const workflowGroup = plan.slices
			.find((slice) => slice.workflowId === workflow.id)
			?.constructionGroups.find((group) => group.kind === "workflow");
		expect(workflowGroup?.blueprintAreas).toContain("case-operations");
	});

	it("plans a standalone form workflow without inventing a record effect", () => {
		const contract = makeWorkflowChainContract(1);
		const workflow = contract.workflows[0];
		workflow.recordEffects = [];
		workflow.readback = [];
		contract.formCompositions[0].mode = "standalone";
		delete contract.moduleCompositions[0].hostRecordId;
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
		});
		expect(
			plan.slices[0].constructionGroups.find(
				(group) => group.kind === "workflow",
			)?.blueprintAreas,
		).toEqual(["app", "forms", "media-references"]);
		expect(workflow.recordEffects).toEqual([]);
	});

	it("authorizes case operations for a standalone conditional primary create", () => {
		const contract = cloneContract(makeContract());
		const workflow = contract.workflows.find(
			(candidate) => candidate.id === ids.taskRegister,
		);
		if (workflow === undefined)
			throw new Error("registration workflow missing");
		const effect = workflow.recordEffects[0];
		if (effect === undefined) throw new Error("create effect missing");
		effect.condition = "The worker gave consent";
		const existingModule = contract.moduleCompositions[0];
		if (existingModule === undefined) throw new Error("module missing");
		existingModule.workflowIds = existingModule.workflowIds.filter(
			(id) => id !== workflow.id,
		);
		const standaloneModuleId = did(880);
		contract.moduleCompositions.unshift({
			id: standaloneModuleId,
			name: "Consent registration",
			purpose: "Host conditional registration without selected record context.",
			role: "form-host",
			workflowIds: [workflow.id],
			actorIds: workflow.actorIds,
			listIds: [],
			orderRationale: "Registration precedes patient follow-up.",
			icon: { kind: "builtin", slug: "default" },
			roleSeparationRationale:
				"Conditional creation cannot use the patient-hosted registration form.",
		});
		const form = contract.formCompositions.find(
			(candidate) => candidate.workflowId === workflow.id,
		);
		if (form === undefined) throw new Error("registration form missing");
		form.moduleCompositionId = standaloneModuleId;
		form.mode = "standalone";

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const workflowGroup = plan.slices
			.find((slice) => slice.workflowId === workflow.id)
			?.constructionGroups.find((group) => group.kind === "workflow");
		expect(workflowGroup?.blueprintAreas).toContain("case-operations");
	});

	it("keeps a list and its queue-only properties with the workflow that materializes its module", () => {
		const contract = cloneContract(makeContract());
		const readOnly = did(34);
		const queueOnly = did(35);
		const patient = contract.records.find(
			(record) => record.id === ids.recPatient,
		);
		const visit = contract.workflows.find(
			(workflow) => workflow.id === ids.taskVisit,
		);
		const list = contract.lists.find((entry) => entry.id === ids.rmPatients);
		if (patient === undefined || visit === undefined || list === undefined) {
			throw new Error("fixture needs patient, visit, and patient list");
		}
		patient.properties.push(
			{
				id: readOnly,
				name: "Imported status",
				meaning: "A status displayed during visits.",
				dataShape: "text",
				sensitivity: "ordinary",
			},
			{
				id: queueOnly,
				name: "Queue marker",
				meaning: "A marker displayed only in the patient queue.",
				dataShape: "text",
				sensitivity: "ordinary",
			},
		);
		visit.readback.push({
			recordId: ids.recPatient,
			purpose: "Show the imported patient status",
			propertyIds: [readOnly],
		});
		list.detailPropertyIds.push(queueOnly);

		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "1".repeat(64) },
			planId: ids.planId,
		});
		const visitSlice = plan.slices.find(
			(slice) => slice.workflowId === ids.taskVisit,
		);
		const visitElements = visitSlice?.constructionGroups.flatMap((group) =>
			group.elements.map((element) => element.id),
		);
		expect(visitElements).toContain(readOnly);
		expect(visitElements).not.toContain(queueOnly);
		const rootGroups = plan.slices[0]?.constructionGroups ?? [];
		expect(
			rootGroups.some((group) =>
				group.elements.some((element) => element.id === queueOnly),
			),
		).toBe(true);
		expect(
			rootGroups.some((group) =>
				group.elements.some((element) => element.id === list.id),
			),
		).toBe(true);
		expect(
			rootGroups.some((group) =>
				group.elements.some((element) => element.id === readOnly),
			),
		).toBe(false);
	});

	it("rejects duplicate workflow slices and construction groups", () => {
		const duplicateWorkflow = makeBuildPlan();
		if (!duplicateWorkflow.slices[0] || !duplicateWorkflow.slices[1]) {
			throw new Error("fixture needs two slices");
		}
		duplicateWorkflow.slices[1].workflowId =
			duplicateWorkflow.slices[0].workflowId;
		expect(messages(buildPlanSchema.safeParse(duplicateWorkflow))).toContain(
			"exactly one slice",
		);

		const duplicateGroup = makeBuildPlan();
		const firstGroup = duplicateGroup.slices[0]?.constructionGroups[0];
		const secondGroup = duplicateGroup.slices[1]?.constructionGroups[0];
		if (!firstGroup || !secondGroup) throw new Error("fixture needs groups");
		secondGroup.id = firstGroup.id;
		expect(messages(buildPlanSchema.safeParse(duplicateGroup))).toContain(
			"group ids must be unique",
		);
	});

	it.each([
		{ edges: [[], [0], [1], [1], [2, 3]], cyclic: [] },
		{ edges: [[0], [], [], [], []], cyclic: [0] },
		{ edges: [[1], [0], [1], [], [2]], cyclic: [0, 1, 2, 4] },
		{ edges: [[], [2], [1], [4], [3]], cyclic: [1, 2, 3, 4] },
		{ edges: [[1, 3], [2], [], [4], [3]], cyclic: [0, 3, 4] },
	])(
		"reports exactly the slices that reach a cycle: $edges",
		({ edges, cyclic }) => {
			const plan = deriveBuildPlan({
				contract: makeWorkflowChainContract(5),
				revision: { id: ids.revisionId, digest: "b".repeat(64) },
			});
			plan.slices.forEach((slice, index) => {
				slice.prerequisiteSliceIds = edges[index].map(
					(target) => plan.slices[target].id,
				);
			});
			const result = buildPlanSchema.safeParse(plan);
			const cyclePaths = result.success
				? []
				: result.error.issues
						.filter(
							(issue) =>
								issue.message === "Slice prerequisites must be acyclic.",
						)
						.map((issue) => issue.path);
			expect(cyclePaths).toEqual(
				cyclic.map((index) => ["slices", index, "prerequisiteSliceIds"]),
			);
			expect(result.success).toBe(cyclic.length === 0);
		},
	);

	it("refuses an unknown prerequisite at its exact coordinate", () => {
		const plan = makeBuildPlan();
		plan.slices[1].prerequisiteSliceIds.push(did(9999));
		const result = buildPlanSchema.safeParse(plan);
		expect(result.success).toBe(false);
		if (result.success)
			throw new Error("Expected missing prerequisite refusal");
		expect(result.error.issues).toEqual([
			{
				code: "custom",
				path: ["slices", 1, "prerequisiteSliceIds", 1],
				message: "The prerequisite slice does not exist.",
			},
		]);
	});

	it("rejects missing or foreign contract elements", () => {
		const missing = makeBuildPlan();
		missing.slices[0]?.constructionGroups[0]?.elements.pop();
		expect(buildPlanSchemaFor(makeContract()).safeParse(missing).success).toBe(
			false,
		);

		const foreign = makeBuildPlan();
		foreign.slices[0]?.constructionGroups[0]?.elements.push({
			kind: "record",
			id: did(7777),
		});
		expect(buildPlanSchemaFor(makeContract()).safeParse(foreign).success).toBe(
			false,
		);
	});

	it("changes slice identities when the accepted revision digest changes", () => {
		const contract = cloneContract(makeContract());
		const changed = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "c".repeat(64) },
			planId: ids.planId,
		});
		expect(changed.slices[0]?.id).not.toBe(makeBuildPlan().slices[0]?.id);
	});

	it("refuses to derive construction for a one-value controlled choice", () => {
		const contract = cloneContract(makeContract());
		const risk = contract.records[0]?.properties.find(
			(property) => property.id === ids.factRisk,
		);
		if (!risk) throw new Error("fixture risk property missing");
		risk.choices = [{ value: "priority", label: "Priority" }];
		expect(() =>
			deriveBuildPlan({
				contract,
				revision: { id: ids.revisionId, digest: "a".repeat(64) },
				planId: ids.planId,
			}),
		).toThrow(/not constructible/);
	});

	it("derives construction for a revision-attested existing lookup choice", () => {
		const contract = cloneContract(makeContract());
		const risk = contract.records[0]?.properties.find(
			(property) => property.id === ids.factRisk,
		);
		if (!risk) throw new Error("fixture risk property missing");
		delete risk.choices;
		risk.choiceSource = {
			kind: "existing-project-lookup",
			tableId: EXISTING_TABLE_ID,
			valueColumnId: EXISTING_VALUE_COLUMN_ID,
			labelColumnId: EXISTING_LABEL_COLUMN_ID,
			inspection: computeLookupChoiceProjectionAttestation({
				tableRevision: lookupRevisionSchema.parse("7"),
				tableName: "Referral urgency",
				valueColumnLabel: "Code",
				labelColumnLabel: "Name",
				rows: [
					{
						rowId: EXISTING_ROW_ID,
						value: "routine",
						label: "Routine",
					},
					{
						rowId: EXISTING_SECOND_ROW_ID,
						value: "priority",
						label: "Priority",
					},
				],
			}),
		};
		const visit = contract.workflows.find(
			(workflow) => workflow.id === ids.taskVisit,
		);
		if (visit === undefined) throw new Error("visit workflow missing");
		visit.inputs.push({
			handle: "risk_confirmation",
			name: "Risk confirmation",
			purpose: "Confirm the selected patient's current risk",
			propertyId: ids.factRisk,
		});
		const visitForm = contract.formCompositions.find(
			(form) => form.workflowId === visit.id,
		);
		if (visitForm?.layout.kind !== "sectioned")
			throw new Error("Expected visit section");
		visitForm.layout.sections[0].items.push({
			kind: "input",
			id: did(891),
			inputHandle: "risk_confirmation",
			labelMarkdown: "Risk confirmation",
		});
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "a".repeat(64) },
			planId: ids.planId,
			lookupMaterialization: {
				receiptId: "00000000-0000-4000-8000-000000000902",
				resultDigest: "b".repeat(64),
				projectRevision: lookupRevisionSchema.parse("7"),
				bindings: [],
			},
		});
		const visitSlice = plan.slices.find(
			(slice) => slice.workflowId === ids.taskVisit,
		);
		const workflowGroup = visitSlice?.constructionGroups.find(
			(group) => group.kind === "workflow",
		);
		expect(workflowGroup?.blueprintAreas).toContain("lookup-references");
	});

	it("refuses unresolved external prerequisites at derivation and stored-plan admission", () => {
		const contract = cloneContract(makeContract());
		contract.externalRequirements.push({
			id: ids.externalSetup,
			name: "Existing media",
			kind: "existing-reference",
			description: "Select an existing Project media asset.",
			relatedWorkflowIds: [ids.taskRegister],
			blocksConstruction: true,
		});
		contract.workflows[0]?.externalRequirementIds.push(ids.externalSetup);
		contract.openQuestions.push({
			id: ids.question,
			question: "Which existing media asset should be attached?",
			blocking: true,
			relatedElementIds: [ids.externalSetup],
		});
		const admittedContract = appDesignContractSchema.parse(contract);
		expect(() =>
			deriveBuildPlan({
				contract: admittedContract,
				revision: { id: ids.revisionId, digest: "d".repeat(64) },
				planId: ids.planId,
			}),
		).toThrow("Accepted design is not constructible: openQuestions.0:");

		// Resolving the prerequisite and its question allows current derivation.
		fixtureValue(
			contract.externalRequirements[0],
			"external prerequisite",
		).blocksConstruction = false;
		fixtureValue(contract.openQuestions[0], "prerequisite question").blocking =
			false;
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "d".repeat(64) },
			planId: ids.planId,
		});
		expect(newPlanAdmissionMessages(plan)).toEqual([]);
		const action = fixtureValue(plan.externalActions[0], "external action");
		expect(action).toMatchObject({
			requirementId: ids.externalSetup,
			timing: "after-slice",
		});

		// The stored-plan schema retains this legacy timing. Its independent
		// environment gate must still refuse it even though current derivation
		// stops at the unanswered question before producing such a plan.
		const storedPlan = buildPlanSchema.parse({
			...plan,
			externalActions: [{ ...action, timing: "blocked" }],
		});
		expect(newPlanAdmissionMessages(storedPlan)).toEqual([
			expect.stringContaining(
				`External action ${action.id} blocks construction, but no registered completion producer`,
			),
		]);
	});

	it("keeps non-blocking workflow readiness out of construction gating", () => {
		const contract = cloneContract(makeContract());
		contract.externalRequirements.push({
			id: ids.externalSetup,
			name: "Worker setup",
			kind: "runtime-readiness",
			description: "Configure the worker role before people run this workflow.",
			relatedWorkflowIds: [ids.taskRegister],
			blocksConstruction: false,
		});
		contract.workflows[0]?.externalRequirementIds.push(ids.externalSetup);
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "e".repeat(64) },
			planId: ids.planId,
		});
		expect(plan.externalActions[0]).toMatchObject({
			kind: "runtime-readiness",
			timing: "after-slice",
		});
		expect(newPlanAdmissionMessages(plan)).toEqual([]);
	});
});
