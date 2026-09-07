import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	cloneContract,
	fixtureValue,
	ids,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import {
	appDesignContractSchema,
	formCompositionSchema,
	moduleCompositionSchema,
} from "@/lib/agent/design/contract";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { asUuid } from "@/lib/domain";
import {
	acceptedEntryPointIssues,
	realizedEntryPointTarget,
} from "../acceptedEntryPointParity";
import {
	acceptedEntryPointRealizations,
	blueprintFormHandle,
	deriveSliceExecutionBrief,
} from "../executionBrief";

function contractWithEntryPoints() {
	const contract = cloneContract(makeContract());
	fixtureValue(contract.moduleCompositions[0], "module").entryPoint = {};
	fixtureValue(contract.moduleCompositions[0], "module").caseListEntryPoint =
		{};
	fixtureValue(contract.formCompositions[0], "form").entryPoint = {
		id: "register_patient",
		ignoreDisplayConditions: true,
	};
	return appDesignContractSchema.parse(contract);
}

function finalBrief() {
	const contract = contractWithEntryPoints();
	const plan = deriveBuildPlan({
		contract,
		planId: ids.planId,
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
	});
	const slice = fixtureValue(plan.slices.at(-1), "final slice");
	return {
		contract,
		plan,
		brief: deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: slice.id,
		}),
	};
}

describe("accepted entry-point construction", () => {
	it("keeps historical absent intent absent and reserves explicit IDs before generating defaults", () => {
		expect(acceptedEntryPointRealizations(makeContract())).toEqual([]);
		const contract = contractWithEntryPoints();
		const module = fixtureValue(contract.moduleCompositions[0], "module");
		module.name = "Register patient";
		expect(
			acceptedEntryPointRealizations(contract).map((entry) => entry.id),
		).toEqual([
			"register_patient_2",
			"register_patient_list",
			"register_patient",
		]);
		expect(appDesignContractSchema.parse(contract)).toEqual(contract);
	});
	it("rejects duplicate external IDs and module visibility bypass", () => {
		const contract = contractWithEntryPoints();
		const module = fixtureValue(contract.moduleCompositions[0], "module");
		module.entryPoint = { id: "register_patient" };
		expect(appDesignContractSchema.safeParse(contract).success).toBe(false);
		expect(
			moduleCompositionSchema.safeParse({
				...module,
				entryPoint: { ignoreDisplayConditions: true },
			}).success,
		).toBe(false);
		const form = fixtureValue(contract.formCompositions[0], "form");
		expect(
			formCompositionSchema.safeParse({
				...form,
				entryPoint: { id: "Unsafe ID" },
			}).success,
		).toBe(false);
	});
	it("defers endpoint realization until all slices and retains exact form creation identity", () => {
		const { contract, plan, brief } = finalBrief();
		expect(brief.entryPointRealizations).toHaveLength(3);
		expect(brief.slice.prerequisiteSliceIds).toEqual(
			expect.arrayContaining(plan.slices.slice(0, -1).map((slice) => slice.id)),
		);
		expect(brief.toolProfile.mutationTools).toContain("addEntryPoint");
		const first = deriveSliceExecutionBrief({
			contract,
			revision: { id: ids.revisionId, digest: "b".repeat(64) },
			plan,
			sliceId: fixtureValue(plan.slices[0], "first").id,
		});
		expect(first.entryPointRealizations).toBeUndefined();
		expect(first.toolProfile.mutationTools).not.toContain("addEntryPoint");
		expect(first.formRealizations[0]?.blueprintFormHandle).toBe(
			blueprintFormHandle(
				fixtureValue(contract.formCompositions[0], "form").id,
			),
		);
	});
	it.each(["module", "case-list", "form"] as const)(
		"matches exact %s identity and refuses missing, extra and wrong behavior",
		(kind) => {
			const { brief } = finalBrief();
			const expected = fixtureValue(
				brief.entryPointRealizations?.find((entry) => entry.kind === kind),
				"endpoint",
			);
			const doc = buildDoc({
				caseTypes: [{ name: "patient", properties: [] }],
				modules: ["Patients", "Patients"].map((name) => ({
					name,

					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Survey",
							type:
								kind === "case-list"
									? ("followup" as const)
									: ("survey" as const),
							fields: [{ id: "note", kind: "text" as const, label: "Note" }],
						},
					],
				})),
			});
			const moduleUuid = fixtureValue(doc.moduleOrder[0], "module");
			const otherModule = fixtureValue(doc.moduleOrder[1], "other module");
			const formUuid = fixtureValue(
				doc.formOrder[moduleUuid]?.[0] ?? doc.formOrder[otherModule]?.[0],
				"form",
			);
			const otherForm = fixtureValue(
				doc.formOrder[otherModule]?.[0],
				"other form",
			);
			const endpointUuid = asUuid("00000000-0000-4000-8000-000000008003");
			const entry = { uuid: endpointUuid, id: expected.id };
			const module = fixtureValue(doc.modules[moduleUuid], "module body");
			const form = fixtureValue(doc.forms[formUuid], "form body");
			if (kind === "module") module.entryPoint = entry;
			else if (kind === "case-list") {
				module.caseListEntryPoint = entry;
			} else form.entryPoint = { ...entry, ignoreDisplayConditions: true };
			assertAdmittedDoc(doc);
			const handles = [
				{
					handle: expected.blueprintModuleHandle,
					uuid: moduleUuid,
					entityKind: "module",
				},
				...(expected.blueprintFormHandle
					? [
							{
								handle: expected.blueprintFormHandle,
								uuid: formUuid,
								entityKind: "form",
							},
						]
					: []),
			];
			const one = { ...brief, entryPointRealizations: [expected] };
			expect(realizedEntryPointTarget(doc, expected, handles)).toEqual({
				kind,
				moduleUuid,
				...(kind === "form" ? { formUuid } : {}),
			});
			expect(acceptedEntryPointIssues(doc, one, handles)).toEqual([]);
			const before = structuredClone(doc);
			for (const wrong of [
				[],
				handles.map((h) => ({ ...h, entityKind: "field" })),
				handles.map((h) => ({
					...h,
					uuid: h.entityKind === "module" ? otherModule : otherForm,
				})),
			]) {
				expect(
					acceptedEntryPointIssues(doc, one, wrong).map(
						(issue) => issue.details.entryPointId,
					),
				).toEqual([expected.id, expected.id]);
			}
			expect(doc).toEqual(before);
			expect(
				acceptedEntryPointIssues(
					doc,
					{ ...brief, entryPointRealizations: undefined },
					[],
				),
			).toEqual([]);
			expect(
				acceptedEntryPointIssues(
					doc,
					{ ...brief, entryPointRealizations: [] },
					handles,
				).map((issue) => issue.details.entryPointId),
			).toEqual([expected.id]);
			if (kind === "form") {
				expect(
					realizedEntryPointTarget(
						doc,
						expected,
						handles.map((h) =>
							h.entityKind === "form" ? { ...h, uuid: otherForm } : h,
						),
					),
				).toBeNull();
				form.entryPoint = entry;
				assertAdmittedDoc(doc);
				expect(
					acceptedEntryPointIssues(doc, one, handles).map(
						(issue) => issue.details.entryPointId,
					),
				).toEqual([expected.id]);
			}
			const current =
				kind === "module"
					? module.entryPoint
					: kind === "case-list"
						? module.caseListEntryPoint
						: form.entryPoint;
			fixtureValue(current, "current endpoint").id = "different_destination";
			assertAdmittedDoc(doc);
			expect(
				acceptedEntryPointIssues(doc, one, handles).map(
					(issue) => issue.details.entryPointId,
				),
			).toEqual([expected.id]);
		},
	);
});
