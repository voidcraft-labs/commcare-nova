import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { changeSetHandleSchema } from "@/lib/agent/change-set/schemas";
import {
	fixtureValue,
	ids,
	makeNestedMenuContract,
	makeThirteenWorkflowContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { asUuid } from "@/lib/domain";
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
	appDesignContractSchema.parse(contract);
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
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			},
			{
				name: childComposition.name,
				caseType: "patient",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
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
	assertAdmittedDoc(doc);
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
		assertAdmittedDoc(doc);
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
		assertAdmittedDoc(doc);
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
		assertAdmittedDoc(doc);
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

	it("reports an accepted child composition that was never materialized", () => {
		const { brief, childUuid, doc, handles } = fixture();
		delete doc.modules[childUuid];
		delete doc.formOrder[childUuid];
		doc.moduleOrder = doc.moduleOrder.filter((uuid) => uuid !== childUuid);
		assertAdmittedDoc(doc);
		const survivingHandles = handles.filter(
			(binding) => binding.uuid !== childUuid,
		);

		expect(acceptedModulePlacementIssues(doc, brief, survivingHandles)).toEqual(
			[
				expect.objectContaining({
					code: "ACCEPTED_MODULE_PLACEMENT_MISMATCH",
					details: expect.objectContaining({
						moduleCompositionId: ids.moduleVisits,
					}),
				}),
			],
		);
	});
	it.each([
		"missing-handle",
		"wrong-kind",
		"missing-entity",
		"wrong-name",
		"wrong-host",
		"missing-parent-handle",
	] as const)("refuses %s without repairing the admitted app", (fault) => {
		const { brief, doc, handles, childUuid, parentUuid } = fixture(
			fault === "wrong-host" ? "duplicate-roots" : "nested",
		);
		const child = fixtureValue(doc.modules[childUuid], "child");
		const bindings = handles.map((binding) => ({ ...binding }));
		const childHandle = fixtureValue(
			bindings.find((binding) => binding.uuid === childUuid),
			"child handle",
		);
		if (fault === "missing-handle")
			childHandle.handle = changeSetHandleSchema.parse("@unrelated");
		if (fault === "wrong-kind") childHandle.entityKind = "form";
		if (fault === "missing-entity")
			childHandle.uuid = asUuid("00000000-0000-4000-8000-000000008888");
		if (fault === "wrong-name") child.name = "Different accepted name";
		if (fault === "wrong-host") {
			doc.caseTypes?.push({
				...fixtureValue(doc.caseTypes?.[0], "patient catalog"),
				name: "household",
			});
			child.caseType = "household";
		}
		if (fault === "missing-parent-handle")
			fixtureValue(
				bindings.find((binding) => binding.uuid === parentUuid),
				"parent handle",
			).handle = changeSetHandleSchema.parse("@unrelated");
		assertAdmittedDoc(doc);
		const before = structuredClone(doc);
		expect(
			acceptedModulePlacementIssues(doc, brief, bindings).map(
				(issue) => issue.details.moduleCompositionId,
			),
		).toContain(ids.moduleVisits);
		expect(doc).toEqual(before);
	});

	it("refuses a reordered pair of equal-name root siblings using actual sibling order", () => {
		const { brief, doc, handles, childUuid, parentUuid } =
			fixture("duplicate-roots");
		doc.moduleOrder = [childUuid, parentUuid];
		assertAdmittedDoc(doc);
		expect(
			acceptedModulePlacementIssues(doc, brief, handles).map((issue) => ({
				id: issue.details.moduleCompositionId,
				after: issue.details.realizedAfterSiblingModuleUuid,
			})),
		).toEqual([
			{ id: ids.modulePatients, after: childUuid },
			{ id: ids.moduleVisits, after: null },
		]);
	});
});

describe("menu order independent of construction", () => {
	it("projects expected earlier slices and inserts an earlier menu when its workflow is built later", () => {
		const source = makeThirteenWorkflowContract();
		const [first, second] = source.moduleCompositions;
		if (first === undefined || second === undefined)
			throw new Error("Fixture requires two modules");
		source.moduleCompositions.splice(0, 2, second, first);
		const contract = appDesignContractSchema.parse(source);
		const revision = { id: crypto.randomUUID(), digest: "a".repeat(64) };
		const plan = deriveBuildPlan({ contract, revision });
		expect(plan.schemaVersion).toBe(1);
		const firstSlice = fixtureValue(plan.slices[0], "first slice");
		const firstBrief = deriveSliceExecutionBrief({
			contract,
			revision,
			plan,
			sliceId: firstSlice.id,
		});
		expect(
			firstBrief.moduleRealizations.some(
				(module) => module.compositionId === second.id,
			),
		).toBe(false);
		expect(
			firstBrief.moduleRealizations.find(
				(module) => module.compositionId === first.id,
			)?.afterSiblingModuleCompositionId,
		).toBeNull();
		const secondSlice = fixtureValue(
			plan.slices.find((slice) =>
				slice.constructionGroups.some((group) =>
					group.elements.some(
						(element) =>
							element.kind === "module-composition" && element.id === second.id,
					),
				),
			),
			"second module slice",
		);
		const brief = deriveSliceExecutionBrief({
			contract,
			revision,
			plan,
			sliceId: secondSlice.id,
		});
		expect(
			brief.moduleRealizations.find(
				(module) => module.compositionId === second.id,
			)?.afterSiblingModuleCompositionId,
		).toBeNull();
		expect(
			brief.moduleRealizations.find(
				(module) => module.compositionId === first.id,
			)?.afterSiblingModuleCompositionId,
		).toBe(second.id);
	});
});
