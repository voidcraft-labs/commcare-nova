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

function fixture(shape: "nested" | "duplicate-roots" = "nested") {
	const contract = makeNestedMenuContract();
	const parentComposition = fixtureValue(
		contract.moduleCompositions.find(
			(composition) => composition.id === ids.modulePatients,
		),
		"parent module composition",
	);
	const childComposition = fixtureValue(
		contract.moduleCompositions.find(
			(composition) => composition.id === ids.moduleVisits,
		),
		"child module composition",
	);
	if (shape === "duplicate-roots") {
		childComposition.name = parentComposition.name;
		childComposition.parentModuleCompositionId = undefined;
	}
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
				name: parentComposition.name,
				caseType: "patient",
				caseListOnly: true,
				forms: [],
			},
			{
				name: childComposition.name,
				caseType: "patient",
				caseListOnly: true,
				forms: [],
			},
		],
	});
	const parentUuid = fixtureValue(doc.moduleOrder[0], "parent module");
	const childUuid = fixtureValue(doc.moduleOrder[1], "child module");
	if (shape === "nested") {
		doc.modules[childUuid] = {
			...fixtureValue(doc.modules[childUuid], "child module body"),
			parentModuleUuid: parentUuid,
		};
	}
	const handles = brief.moduleRealizations.map((realization) => ({
		handle: realization.blueprintModuleHandle,
		uuid:
			realization.compositionId === ids.modulePatients ? parentUuid : childUuid,
		entityKind: "module",
	}));
	return { brief, childUuid, doc, handles, parentUuid };
}

describe("accepted module placement", () => {
	it("resolves a module only in its accepted parent menu", () => {
		const { brief, childUuid, doc, handles } = fixture();
		expect(realizedModuleUuid(doc, brief, ids.moduleVisits, handles)).toBe(
			childUuid,
		);
		expect(acceptedModulePlacementIssues(doc, brief, handles)).toEqual([]);
	});

	it("keeps equal-name equal-host root siblings distinct by exact handle", () => {
		const { brief, childUuid, doc, handles, parentUuid } =
			fixture("duplicate-roots");
		expect(realizedModuleUuid(doc, brief, ids.modulePatients, handles)).toBe(
			parentUuid,
		);
		expect(realizedModuleUuid(doc, brief, ids.moduleVisits, handles)).toBe(
			childUuid,
		);
		expect(acceptedModulePlacementIssues(doc, brief, handles)).toEqual([]);
	});

	it("rejects swapped identities even when root sibling semantics are equal", () => {
		const { brief, childUuid, doc, handles, parentUuid } =
			fixture("duplicate-roots");
		const swapped = handles.map((binding) => ({
			...binding,
			uuid: binding.uuid === parentUuid ? childUuid : parentUuid,
		}));
		expect(acceptedModulePlacementIssues(doc, brief, swapped)).toHaveLength(2);
	});

	it("reports a child that materialized as a top-level module", () => {
		const { brief, childUuid, doc, handles } = fixture();
		doc.modules[childUuid] = {
			...fixtureValue(doc.modules[childUuid], "child module body"),
			parentModuleUuid: undefined,
		};
		expect(realizedModuleUuid(doc, brief, ids.moduleVisits, handles)).toBe(
			childUuid,
		);
		expect(acceptedModulePlacementIssues(doc, brief, handles)).toEqual([
			expect.objectContaining({
				code: "ACCEPTED_MODULE_PLACEMENT_MISMATCH",
				location: { kind: "module", moduleUuid: childUuid },
			}),
		]);
	});
});
