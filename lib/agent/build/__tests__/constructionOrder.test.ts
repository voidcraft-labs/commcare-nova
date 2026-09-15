/** Plan ownership through accepted input preparation and the real mutation
 * gate. Persistence is controlled; this does not establish full conformance. */
import { expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import {
	addPatientReviewWorkflow,
	cloneContract,
	did,
	fixtureValue,
	ids,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import { createFormTool } from "@/lib/agent/tools/createForm";
import { createModuleTool } from "@/lib/agent/tools/createModule";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { asUuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { prepareAcceptedConstruction } from "../acceptedConstruction";
import {
	blueprintModuleHandle,
	deriveSliceExecutionBrief,
} from "../executionBrief";

function historyDesign(nested = true) {
	const contract = cloneContract(makeContract());
	if (!nested) contract.charter.initialWorkflowId = ids.taskVisit;
	addPatientReviewWorkflow(contract);
	const parent = fixtureValue(contract.moduleCompositions[0], "patient home");
	parent.workflowIds = parent.workflowIds.filter((id) => id !== ids.taskReview);
	const review = fixtureValue(
		contract.workflows.find((workflow) => workflow.id === ids.taskReview),
		"review workflow",
	);
	const record = fixtureValue(
		contract.records.find((record) => record.id === ids.recVisit),
		"visit record",
	);
	const properties = record.properties.map((property) => property.id);
	Object.assign(review, {
		name: "Review visit",
		goal: "Read an earlier visit without changing it.",

		startingConditions: ["A visit has been recorded."],
		contextRecordId: record.id,
		inputs: [],
		decisions: [],
		recordEffects: [],
		readback: [
			{
				recordId: record.id,
				propertyIds: properties,
				purpose: "Read the saved visit.",
			},
		],
		acceptanceExamples: [
			{
				name: "Read visit history",
				given: ["A saved visit exists"],
				when: ["The worker opens it"],
				expectedResults: ["Its details are shown without changing them"],
			},
		],
	});
	const listId = did(9100);
	contract.lists.push({
		...fixtureValue(contract.lists[0], "patient list"),
		id: listId,
		name: "Visit history",
		recordId: record.id,
		scanPropertyIds: properties,
		detailPropertyIds: properties,
		searchPropertyIds: [],
	});
	contract.moduleCompositions.push({
		...parent,
		id: ids.moduleVisits,
		name: "Visit history",
		...(nested ? { parentModuleCompositionId: parent.id } : {}),
		hostRecordId: record.id,
		workflowIds: [review.id],
		listIds: [listId],
		selection: { cases: "one" },
	});
	const form = fixtureValue(
		contract.formCompositions.find((form) => form.id === ids.formReview),
		"history form",
	);
	form.moduleCompositionId = ids.moduleVisits;
	form.name = "Read visit";
	form.layout = {
		kind: "flat",
		rationale: "One saved-record summary needs no section.",
		items: [
			{
				kind: "record-summary",
				id: ids.itemReviewSummary,
				recordId: record.id,
				propertyIds: properties,
				purpose: "Show the recorded visit.",
			},
		],
	};
	return appDesignContractSchema.parse(contract);
}

it.each([
	{ view: "list", nested: true },
	{ view: "form", nested: true },
	{ view: "list", nested: false },
	{ view: "form", nested: false },
] as const)(
	"constructs $view history before its writer with a nested menu: $nested",
	async ({ view, nested }) => {
		const contract = historyDesign(nested);
		if (view === "list") {
			contract.formCompositions = contract.formCompositions.filter(
				(form) => form.workflowId !== ids.taskReview,
			);
			const module = fixtureValue(
				contract.moduleCompositions.find(
					(item) => item.id === ids.moduleVisits,
				),
				"history module",
			);
			module.role = "queue-only";
			delete module.selection;
			appDesignContractSchema.parse(contract);
		}
		const revision = { id: ids.revisionId, digest: "b".repeat(64) };
		const plan = deriveBuildPlan({ contract, revision, planId: ids.planId });
		const slice = (workflowId: string) =>
			fixtureValue(
				plan.slices.find((slice) => slice.workflowId === workflowId),
				"slice",
			);
		const writerSlice = slice(ids.taskVisit);
		const reviewSlice = view === "form" ? slice(ids.taskReview) : undefined;
		const writer = deriveSliceExecutionBrief({
			contract,
			revision,
			plan,
			sliceId: writerSlice.id,
		});
		const review =
			reviewSlice === undefined
				? undefined
				: deriveSliceExecutionBrief({
						contract,
						revision,
						plan,
						sliceId: reviewSlice.id,
					});
		const child = fixtureValue(
			writer.moduleRealizations.find(
				(module) => module.compositionId === ids.moduleVisits,
			),
			"early viewer",
		);
		expect(child).toMatchObject({
			action: "create",
			role: view === "form" ? "form-and-queue" : "queue-only",
			formCompositionIds: [],
		});
		if (review !== undefined && reviewSlice !== undefined) {
			expect(
				review.moduleRealizations.find(
					(module) => module.compositionId === ids.moduleVisits,
				)?.action,
			).toBe("reuse");
			expect(reviewSlice.prerequisiteSliceIds).toContain(writerSlice.id);
			expect(writerSlice.prerequisiteSliceIds).not.toContain(reviewSlice.id);
		} else {
			expect(plan.slices.map((item) => item.workflowId)).toEqual(
				nested
					? [ids.taskRegister, ids.taskVisit]
					: [ids.taskVisit, ids.taskRegister],
			);
			expect(writer.readWorkflows?.map((item) => item.id)).toEqual([
				ids.taskReview,
			]);
		}
		expect(
			contract.moduleCompositions.find(
				(module) => module.id === ids.moduleVisits,
			)?.workflowIds,
		).toEqual([ids.taskReview]);

		const parentUuid = asUuid(ids.modulePatients);
		const h = makeToolWorkspaceHarness(
			buildDoc({
				caseTypes: ["patient", "visit"].map((name) => ({
					name,
					...(name === "visit"
						? { parent_type: "patient", relationship: "child" as const }
						: {}),
					properties: [{ name: "case_name", label: "Name", data_type: "text" }],
				})),
				modules: [
					{
						uuid: parentUuid,
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Register patient",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "case_name",
										label: proseText("Name"),
										caseWrite: { caseType: "patient", property: "case_name" },
									}),
								],
							},
						],
					},
				],
			}),
		);
		expect(runValidation(h.currentDoc(), LOOKUP_CONTEXT_UNAVAILABLE)).toEqual(
			[],
		);
		let bindings: ReturnType<typeof prepareAcceptedConstruction>["bindings"] = [
			{
				handle: blueprintModuleHandle(ids.modulePatients),
				uuid: parentUuid,
				entityKind: "module",
			},
		];
		const prepare = (
			toolName: "createModule" | "createForm",
			brief: typeof writer,
			input: Record<string, unknown>,
		) => {
			const prepared = prepareAcceptedConstruction({
				toolName,
				brief,
				input,
				doc: h.currentDoc(),
				bindings,
			});
			bindings = [...bindings, ...prepared.bindings];
			return prepared.input;
		};
		const writerForm = fixtureValue(writer.formRealizations[0], "writer form");
		const writerInput = {
			moduleUuid: parentUuid,
			name: writerForm.name,
			fields: [
				{
					kind: "text",
					id: "visit_name",
					label: proseText("Visit name"),
					caseWrite: { caseType: "visit", property: "case_name" },
				},
			],
		};
		const beforeBindings = bindings;
		const beforeAttempt = h.currentDoc();
		const refused = await h.runTool(
			createFormTool,
			prepare("createForm", writer, writerInput),
		);
		expect(refused.result).toHaveProperty(
			"error",
			expect.stringContaining("no module to display"),
		);
		expect(h.currentDoc()).toBe(beforeAttempt);
		bindings = beforeBindings;
		const beforeViewer = h.currentDoc();
		const createdViewer = await h.runTool(
			createModuleTool,
			prepare("createModule", writer, { name: "Visit history" }),
		);
		expect(
			createdViewer.result,
			JSON.stringify(createdViewer.result),
		).toHaveProperty("ok", true);
		expect(h.currentDoc().modules[ids.moduleVisits]).toMatchObject({
			caseListOnly: true,
			...(nested ? { parentModuleUuid: parentUuid } : {}),
		});
		expect(h.currentDoc()).not.toBe(beforeViewer);
		const saved = await h.runTool(
			createFormTool,
			prepare("createForm", writer, writerInput),
		);
		expect(saved.result, JSON.stringify(saved.result)).toHaveProperty(
			"ok",
			true,
		);
		if (review !== undefined) {
			const createdReview = await h.runTool(
				createFormTool,
				prepare("createForm", review, {
					moduleUuid: ids.moduleVisits,
					name: "Read visit",
					fields: [
						{
							kind: "label",
							id: "saved_visit",
							label: proseText("Saved visit details"),
						},
					],
				}),
			);
			expect(
				createdReview.result,
				JSON.stringify(createdReview.result),
			).toHaveProperty("ok", true);
			expect(h.currentDoc().modules[ids.moduleVisits]?.caseListOnly).not.toBe(
				true,
			);
			expect(h.currentDoc().formOrder[ids.moduleVisits]).toHaveLength(1);
		} else {
			expect(h.currentDoc().modules[ids.moduleVisits]?.caseListOnly).toBe(true);
			expect(h.currentDoc().formOrder[ids.moduleVisits] ?? []).toHaveLength(0);
		}
		expect(h.currentDoc().modules[ids.moduleVisits]?.parentModuleUuid).toBe(
			nested ? parentUuid : undefined,
		);
		expect(runValidation(h.currentDoc(), LOOKUP_CONTEXT_UNAVAILABLE)).toEqual(
			[],
		);
	},
);

it("keeps a no-matches registration outside a viewer's menu", async () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: "Name", data_type: "text" }],
			},
		],
	});
	const moduleUuid = fixtureValue(doc.moduleOrder[0], "viewer");
	const h = makeToolWorkspaceHarness(doc);
	expect(runValidation(h.currentDoc(), LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const result = await h.runTool(createFormTool, {
		moduleUuid,
		name: "Register new patient",
		type: "registration",
		entry: { kind: "search-no-matches" },
		post_submit: "app_home",
		fields: [
			{
				kind: "text",
				id: "case_name",
				label: proseText("Patient name"),
				caseWrite: { caseType: "patient", property: "case_name" },
			},
		],
	});
	expect(result.result, JSON.stringify(result.result)).toHaveProperty(
		"ok",
		true,
	);
	expect(h.currentDoc().modules[moduleUuid]?.caseListOnly).toBe(true);
	expect(runValidation(h.currentDoc(), LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
});
