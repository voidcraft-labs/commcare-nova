import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import type { ToolExecutionContext } from "@/lib/agent/toolExecutionContext";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import {
	addLocationPropertiesTool,
	addOrganizationLevelsTool,
	updateOrganizationLevelInputSchema,
} from "../organization";

function context(): ToolExecutionContext {
	return {
		appId: "organization-tool-app",
		projectId: "organization-tool-project",
		userId: "member",
		runId: "run",
		recordMutations: vi.fn(async (prepared: PreparedMutationCandidate) => ({
			events: [],
			committedDoc: prepared.nextDoc,
		})),
		recordMutationStages: vi.fn(),
		recordConversation: vi.fn(),
	} as unknown as ToolExecutionContext;
}

describe("organization authoring tools", () => {
	it("creates levels and place-information fields through guarded mutations", async () => {
		const ctx = context();
		const doc = makeCanonicalGenesisDoc("Organization", ctx.appId);
		const level = await addOrganizationLevelsTool.execute(
			{
				levels: [
					{
						code: "facility",
						name: "Facility",
						caseFlow: {
							workers: "assigned",
							ownsCases: true,
							descendantCases: { kind: "none" },
						},
						addressBook: { reach: "own-branch" },
					},
				],
			},
			ctx,
			doc,
		);
		if (!("uuids" in level.result)) throw new Error("level creation failed");
		const levelUuid = level.result.uuids[0];
		expect(level.newDoc.organizationLevels?.[levelUuid]).toMatchObject({
			code: "facility",
			name: "Facility",
		});

		const property = await addLocationPropertiesTool.execute(
			{
				properties: [
					{
						slug: "phone",
						label: "Phone",
						levelUuids: [levelUuid],
					},
				],
			},
			ctx,
			level.newDoc,
		);
		if (!("uuids" in property.result)) {
			throw new Error("property creation failed");
		}
		expect(
			property.newDoc.locationProperties?.[property.result.uuids[0]],
		).toMatchObject({ slug: "phone", levelUuids: [levelUuid] });
	});

	it("does not expose the create-once level code on updates", () => {
		const json = z.toJSONSchema(updateOrganizationLevelInputSchema, {
			target: "draft-7",
			io: "input",
		}) as { properties?: Record<string, unknown> };
		expect(json.properties).not.toHaveProperty("code");
		expect(
			updateOrganizationLevelInputSchema.safeParse({
				uuid: "11111111-1111-4111-8111-111111111111",
				code: "renamed",
			}).success,
		).toBe(false);
	});
});
