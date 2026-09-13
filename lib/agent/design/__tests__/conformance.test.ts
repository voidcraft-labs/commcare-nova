import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import type { ModuleHandleBinding } from "@/lib/agent/build/acceptedModulePlacement";
import {
	blueprintFormHandle,
	blueprintInputHandle,
	blueprintModuleHandle,
	deriveSliceExecutionBrief,
	formCompositionInputs,
} from "@/lib/agent/build/executionBrief";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { applyMutations } from "@/lib/doc/mutations";
import { eq, literal, term } from "@/lib/domain/predicate";
import { deriveBuildPlan } from "../buildPlan";
import {
	assessAcceptedWorkflow,
	conformanceFindingSchema,
} from "../conformance";
import { appDesignContractSchema } from "../contract";
import { fixtureValue, ids, makeWorkflowChainContract } from "./fixtures";

function fixture() {
	const contract = makeWorkflowChainContract(1);
	const plan = deriveBuildPlan({
		contract,
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
	});
	const brief = deriveSliceExecutionBrief({
		contract,
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		plan,
		sliceId: fixtureValue(plan.slices[0], "slice").id,
	});
	const form = fixtureValue(brief.formRealizations[0], "form");
	const input = fixtureValue(formCompositionInputs(form)[0], "input");
	const record = fixtureValue(brief.recordRealizations[0], "record");
	const property = fixtureValue(brief.records[0]?.properties[0], "property");
	const moduleUuid = testUuid("conformance-module");
	const formUuid = testUuid("conformance-form");
	const fieldUuid = testUuid("conformance-input");
	const groupUuid = testUuid("conformance-group");
	const doc = buildDoc({
		caseTypes: [
			{
				name: record.blueprintCaseType,
				properties: [
					{
						name: property.blueprintProperty,
						label: "Value",
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: moduleUuid,
				name: "Worker's menu",
				caseType: record.blueprintCaseType,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: formUuid,
						name: "Worker's form",
						type: "registration",
						fields: [
							f({
								id: "record_name",
								kind: "hidden",
								calculate: xp("'Entry'"),
								caseWrite: {
									caseType: record.blueprintCaseType,
									property: "case_name",
								},
							}),
							f({
								uuid: groupUuid,
								id: "answers",
								kind: "group",
								children: [
									f({
										uuid: fieldUuid,
										id: "worker_answer",
										kind: "text",
										caseWrite: {
											caseType: record.blueprintCaseType,
											property: property.blueprintProperty,
										},
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	const bindings: ModuleHandleBinding[] = [
		{
			handle: blueprintModuleHandle(form.moduleCompositionId),
			uuid: moduleUuid,
			entityKind: "module",
		},
		{
			handle: blueprintFormHandle(form.compositionId),
			uuid: formUuid,
			entityKind: "form",
		},
		{
			handle: blueprintInputHandle(input.compositionItemId),
			uuid: fieldUuid,
			entityKind: "field",
		},
	];
	return {
		doc,
		brief,
		bindings,
		moduleUuid,
		formUuid,
		fieldUuid,
		groupUuid,
		record,
		property,
		contract,
	};
}

describe("accepted workflow structural conformance", () => {
	it("follows bound inputs through renames and moves without guessing from accepted names", () => {
		const setup = fixture();
		expect(assessAcceptedWorkflow(setup)).toEqual([]);
		const doc = produce(setup.doc, (draft) => {
			applyMutations(draft, [
				{ kind: "renameForm", uuid: setup.formUuid, newId: "Renamed form" },
				{
					kind: "moveField",
					uuid: setup.fieldUuid,
					toParentUuid: setup.formUuid,
					after: null,
				},
				{ kind: "removeField", uuid: setup.groupUuid },
			]);
		});
		assertAdmittedDoc(doc);
		expect(assessAcceptedWorkflow({ ...setup, doc })).toEqual([]);
		const findings = assessAcceptedWorkflow({
			...setup,
			doc,
			bindings: setup.bindings.slice(0, 2),
		});
		expect(findings.map((finding) => finding.code)).toEqual([
			"WORKFLOW_INPUT_MISSING",
		]);
		for (const finding of findings)
			expect(conformanceFindingSchema.parse(finding)).toEqual(finding);
	});

	it("distinguishes missing form identity from missing input identity", () => {
		const setup = fixture();
		expect(
			assessAcceptedWorkflow({ ...setup, bindings: [] }).map(
				(finding) => finding.code,
			),
		).toEqual(["WORKFLOW_FORM_MISSING"]);
		expect(() =>
			assessAcceptedWorkflow({
				...setup,
				bindings: [
					...setup.bindings,
					{ ...setup.bindings[0], uuid: testUuid("other-module") },
				],
			}),
		).toThrow("Conflicting implementation binding");
	});

	it("rejects a field that cannot capture the accepted answer type", () => {
		const setup = fixture();
		const doc = produce(setup.doc, (draft) => {
			const field = draft.fields[setup.fieldUuid];
			if (field.kind !== "text") throw new Error("Expected text input");
			draft.fields[setup.fieldUuid] = {
				uuid: field.uuid,
				id: field.id,
				label: field.label,
				kind: "int",
			};
		});
		assertAdmittedDoc(doc);
		expect(
			assessAcceptedWorkflow({ ...setup, doc }).map((finding) => finding.code),
		).toEqual(["WORKFLOW_INPUT_TYPE_MISMATCH", "RECORD_WRITE_MISSING"]);
	});

	it("requires only explicitly accepted writes, not every input's property association", () => {
		const setup = fixture();
		const doc = produce(setup.doc, (draft) => {
			const field = draft.fields[setup.fieldUuid];
			if (field.kind !== "text") throw new Error("Expected text input");
			delete field.caseWrite;
		});
		assertAdmittedDoc(doc);
		expect(
			assessAcceptedWorkflow({ ...setup, doc }).map((finding) => finding.code),
		).toEqual(["RECORD_WRITE_MISSING"]);
		const contract = appDesignContractSchema.parse(
			produce(setup.contract, (draft) => {
				draft.workflows[0].recordEffects[0].writes = [];
			}),
		);
		const plan = deriveBuildPlan({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
		});
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: fixtureValue(plan.slices[0], "slice").id,
		});
		expect(assessAcceptedWorkflow({ ...setup, doc, brief })).toEqual([]);
	});

	it("does not treat a follow-up update as the accepted creation", () => {
		const setup = fixture();
		const doc = produce(setup.doc, (draft) => {
			draft.forms[setup.formUuid].type = "followup";
		});
		assertAdmittedDoc(doc);
		expect(
			assessAcceptedWorkflow({ ...setup, doc }).map((finding) => finding.code),
		).toEqual(["RECORD_EFFECT_MISSING"]);
	});

	it("reports an incompatible persisted type even when the field and writer agree", () => {
		const setup = fixture();
		const doc = produce(setup.doc, (draft) => {
			const field = draft.fields[setup.fieldUuid];
			if (field.kind !== "text") throw new Error("Expected text input");
			draft.fields[setup.fieldUuid] = {
				uuid: field.uuid,
				id: field.id,
				label: field.label,
				kind: "int",
				caseWrite: field.caseWrite,
			};
			fixtureValue(draft.caseTypes?.[0].properties[0], "property").data_type =
				"int";
		});
		assertAdmittedDoc(doc);
		expect(
			assessAcceptedWorkflow({ ...setup, doc }).map((finding) => finding.code),
		).toEqual([
			"WORKFLOW_INPUT_TYPE_MISMATCH",
			"RECORD_PROPERTY_TYPE_MISMATCH",
		]);
	});

	it("requires the exact accepted module home", () => {
		const setup = fixture();
		const findings = assessAcceptedWorkflow({
			...setup,
			bindings: setup.bindings.map((binding) =>
				binding.entityKind === "module"
					? { ...binding, uuid: testUuid("another-module") }
					: binding,
			),
		});
		expect(findings.map((finding) => finding.code)).toEqual([
			"WORKFLOW_FORM_HOST_MISMATCH",
		]);
	});

	it("recognizes explicit creation without claiming that its value or condition is correct", () => {
		const setup = fixture();
		const doc = produce(setup.doc, (draft) => {
			draft.forms[setup.formUuid].type = "followup";
			const field = draft.fields[setup.fieldUuid];
			if (field.kind !== "text") throw new Error("Expected text input");
			delete field.caseWrite;
			draft.forms[setup.formUuid].caseOperations = [
				{
					uuid: testUuid("explicit-create"),
					id: "create_entry",
					action: "create",
					caseType: setup.record.blueprintCaseType,
					target: { kind: "new" },
					name: term(literal("Entry")),
					condition: eq(literal(1), literal(0)),
					writes: [
						{
							property: setup.property.blueprintProperty,
							value: term(literal("wrong answer")),
						},
					],
				},
			];
		});
		assertAdmittedDoc(doc);
		expect(assessAcceptedWorkflow({ ...setup, doc })).toEqual([]);
	});
});
