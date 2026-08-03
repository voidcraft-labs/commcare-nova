import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, withUserSequences } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { summarizeBlueprint } from "../summarizeBlueprint";

describe("summarizeBlueprint users projection", () => {
	it("keeps complete organization level settings visible for replacement edits", () => {
		const rootUuid = testUuid("summary-root-level");
		const leafUuid = testUuid("summary-leaf-level");
		const doc = buildDoc() as BlueprintDoc;
		doc.organizationLevels = {
			[rootUuid]: {
				uuid: rootUuid,
				code: "region",
				name: "Region",
				caseFlow: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: { kind: "down-to", levelUuid: leafUuid },
				},
				addressBook: {
					reach: "own-branch",
					downToLevelUuid: leafUuid,
					alsoIncludeTopDownToLevelUuid: rootUuid,
				},
			},
			[leafUuid]: {
				uuid: leafUuid,
				code: "facility",
				name: "Facility",
				parentLevelUuid: rootUuid,
				caseFlow: { workers: "none", ownsCases: true },
				addressBook: { reach: "whole-organization" },
			},
		};
		doc.organizationLevelOrder = [rootUuid, leafUuid];

		const summary = summarizeBlueprint(doc);
		expect(summary).toContain(
			`case_flow=${JSON.stringify(doc.organizationLevels[rootUuid]?.caseFlow)}`,
		);
		expect(summary).toContain(
			`address_book=${JSON.stringify(doc.organizationLevels[rootUuid]?.addressBook)}`,
		);
	});

	it("exposes stable property, role, and persona identities for follow-up edits", () => {
		const propertyUuid = testUuid("property-region");
		const roleUuid = testUuid("role-chw");
		const personaUuid = testUuid("persona-asha");
		const doc: BlueprintDoc = withUserSequences({
			...buildDoc(),
			userProperties: {
				[propertyUuid]: {
					uuid: propertyUuid,
					slug: "region",
					label: "Region",
					choices: ["north", "south"],
				},
			},
			userTypes: {
				[roleUuid]: {
					uuid: roleUuid,
					name: "Community health worker",
					description: "Visits households",
					values: { [propertyUuid]: "north" },
				},
			},
			personas: {
				[personaUuid]: {
					uuid: personaUuid,
					name: "Asha",
					description: "South district",
					userTypeUuid: roleUuid,
					values: { [propertyUuid]: "south" },
				},
			},
		});

		const summary = summarizeBlueprint(doc);
		expect(summary).toContain(`region: "Region" [uuid ${propertyUuid}]`);
		expect(summary).toContain(`"Community health worker" [uuid ${roleUuid}]`);
		expect(summary).toContain('description="Visits households"');
		expect(summary).toContain(`region="north" [property uuid ${propertyUuid}]`);
		expect(summary).toContain(`"Asha" [uuid ${personaUuid}]`);
		expect(summary).toContain('description="South district"');
		expect(summary).toContain(
			`role="Community health worker" [uuid ${roleUuid}]`,
		);
		expect(summary).toContain(`region="south" [property uuid ${propertyUuid}]`);
	});
});
