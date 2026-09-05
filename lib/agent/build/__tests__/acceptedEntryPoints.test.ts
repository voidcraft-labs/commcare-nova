import { describe, expect, it } from "vitest";
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
import { asUuid, type BlueprintDoc } from "@/lib/domain";
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
		).toEqual(["register_patient_2", "register_patient"]);
		expect(acceptedEntryPointRealizations(contract)).toEqual(
			acceptedEntryPointRealizations(contract),
		);
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
		expect(brief.entryPointRealizations).toHaveLength(2);
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
	it("proves the exact form binding, missing coverage, and bypass instead of matching display names", () => {
		const { brief } = finalBrief();
		const expected = fixtureValue(
			brief.entryPointRealizations?.find((entry) => entry.kind === "form"),
			"form endpoint",
		);
		const moduleUuid = asUuid("00000000-0000-4000-8000-000000008001");
		const formUuid = asUuid("00000000-0000-4000-8000-000000008002");
		const endpointUuid = asUuid("00000000-0000-4000-8000-000000008003");
		const doc = {
			modules: { [moduleUuid]: { uuid: moduleUuid } },
			forms: {
				[formUuid]: {
					uuid: formUuid,
					entryPoint: {
						uuid: endpointUuid,
						id: expected.id,
						ignoreDisplayConditions: true,
					},
				},
			},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [formUuid] },
		} as unknown as BlueprintDoc;
		const handles = [
			{
				handle: expected.blueprintModuleHandle,
				uuid: moduleUuid,
				entityKind: "module",
			},
			{
				handle: expected.blueprintFormHandle ?? "",
				uuid: formUuid,
				entityKind: "form",
			},
		];
		const one = { ...brief, entryPointRealizations: [expected] };
		expect(realizedEntryPointTarget(doc, expected, handles)).toEqual({
			kind: "form",
			moduleUuid,
			formUuid,
		});
		expect(acceptedEntryPointIssues(doc, one, handles)).toEqual([]);
		expect(acceptedEntryPointIssues(doc, one, handles.slice(0, 1))).not.toEqual(
			[],
		);
		const form = fixtureValue(doc.forms[formUuid], "realized form");
		form.entryPoint = { uuid: endpointUuid, id: expected.id };
		expect(acceptedEntryPointIssues(doc, one, handles)[0]?.code).toBe(
			"ACCEPTED_ENTRY_POINT_MISMATCH",
		);
	});
});
