import { describe, expect, it } from "vitest";
import { buildDoc, withUserSequences } from "@/lib/__tests__/docHelpers";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { summarizeBlueprint } from "../summarizeBlueprint";

describe("summarizeBlueprint users projection", () => {
	it("exposes stable property, role, and persona identities for follow-up edits", () => {
		const propertyUuid = asUuid("property-region");
		const roleUuid = asUuid("role-chw");
		const personaUuid = asUuid("persona-asha");
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
