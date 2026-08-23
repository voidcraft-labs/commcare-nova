import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	fixtureValue,
	ids,
	makeNestedMenuContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import {
	acceptedModulePlacementIssues,
	realizedModuleUuid,
} from "../acceptedModulePlacement";
import { deriveSliceExecutionBrief } from "../executionBrief";

function fixture() {
	const contract = makeNestedMenuContract();
	const plan = deriveBuildPlan({
		contract,
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
	});
	const slice = fixtureValue(
		plan.slices.find((entry) => entry.workflowId === ids.taskVisit),
		"child workflow slice",
	);
	const brief = deriveSliceExecutionBrief({
		contract,
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		plan,
		sliceId: slice.id,
	});
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patient care",
				caseType: "patient",
				caseListOnly: true,
				forms: [],
			},
			{
				name: "Patient visits",
				caseType: "patient",
				caseListOnly: true,
				forms: [],
			},
		],
	});
	const parentUuid = fixtureValue(doc.moduleOrder[0], "parent module");
	const childUuid = fixtureValue(doc.moduleOrder[1], "child module");
	doc.modules[childUuid] = {
		...fixtureValue(doc.modules[childUuid], "child module body"),
		parentModuleUuid: parentUuid,
	};
	return { brief, childUuid, doc };
}

describe("accepted module placement", () => {
	it("resolves a module only in its accepted parent menu", () => {
		const { brief, childUuid, doc } = fixture();
		expect(realizedModuleUuid(doc, brief, ids.moduleVisits)).toBe(childUuid);
		expect(acceptedModulePlacementIssues(doc, brief)).toEqual([]);
	});

	it("reports a child that materialized as a top-level module", () => {
		const { brief, childUuid, doc } = fixture();
		doc.modules[childUuid] = {
			...fixtureValue(doc.modules[childUuid], "child module body"),
			parentModuleUuid: undefined,
		};
		expect(realizedModuleUuid(doc, brief, ids.moduleVisits)).toBeNull();
		expect(acceptedModulePlacementIssues(doc, brief)).toEqual([
			expect.objectContaining({
				code: "ACCEPTED_MODULE_PLACEMENT_MISMATCH",
				location: { kind: "module", moduleUuid: childUuid },
			}),
		]);
	});
});
