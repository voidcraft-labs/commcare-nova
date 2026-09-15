import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	fixtureValue,
	ids,
	makeBuildPlan,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import {
	acceptedConstructionIdentities,
	prepareAcceptedConstruction,
} from "../acceptedConstruction";
import {
	blueprintModuleHandle,
	deriveSliceExecutionBrief,
} from "../executionBrief";

function brief() {
	const plan = makeBuildPlan();
	return deriveSliceExecutionBrief({
		contract: makeContract(),
		revision: { id: ids.revisionId, digest: "b".repeat(64) },
		plan,
		sliceId: fixtureValue(plan.slices[0], "slice").id,
	});
}

describe("accepted construction identities", () => {
	it("keeps existing implementation identity even when names change", () => {
		const accepted = brief();
		const module = fixtureValue(accepted.moduleRealizations[0], "module");
		const doc = buildDoc({ modules: [{ name: "A renamed module" }] });
		const uuid = fixtureValue(doc.moduleOrder[0], "implemented module");
		const bindings = [
			{ handle: module.blueprintModuleHandle, uuid, entityKind: "module" },
		];
		expect(
			acceptedConstructionIdentities({ brief: accepted, doc, bindings }),
		).toContainEqual(
			expect.objectContaining({
				compositionId: module.compositionId,
				uuid,
				exists: true,
			}),
		);
		expect(() =>
			acceptedConstructionIdentities({
				brief: accepted,
				doc,
				bindings: [{ ...bindings[0], entityKind: "form" }],
			}),
		).toThrow("no longer identifies");
	});
	it("refuses an occupied UUID without an exact implementation binding", () => {
		const accepted = brief();
		const module = fixtureValue(accepted.moduleRealizations[0], "module");
		const doc = buildDoc({
			modules: [{ uuid: module.compositionId, name: "Unrelated module" }],
		});
		expect(() =>
			acceptedConstructionIdentities({ brief: accepted, doc, bindings: [] }),
		).toThrow("already occupied");
	});
	it("requires an explicit composition identity when two new modules share a name", () => {
		const accepted = brief();
		const module = fixtureValue(accepted.moduleRealizations[0], "module");
		const composition = fixtureValue(
			accepted.moduleCompositions.find(
				(item) => item.id === module.compositionId,
			),
			"composition",
		);
		// Duplicate names are not identities. The same accepted module choices can
		// be presented without making either one the default target.
		const duplicateId = ids.moduleVisits;
		const duplicate = {
			...accepted,
			moduleCompositions: [
				...accepted.moduleCompositions,
				{ ...composition, id: duplicateId },
			],
			moduleRealizations: [
				...accepted.moduleRealizations,
				{
					...module,
					compositionId: duplicateId,
					blueprintModuleHandle: blueprintModuleHandle(duplicateId),
				},
			],
		};
		const args = {
			toolName: "createModule",
			brief: duplicate,
			doc: emptyBlueprintDoc("test-app"),
			bindings: [],
			input: { name: composition.name, forms: [] },
		};
		expect(() => prepareAcceptedConstruction(args)).toThrow(
			"Several accepted modules",
		);
		expect(
			prepareAcceptedConstruction({
				...args,
				input: { ...args.input, moduleUuid: duplicateId },
			}),
		).toMatchObject({
			input: { moduleUuid: duplicateId },
			bindings: [{ uuid: duplicateId }],
		});
	});
});
