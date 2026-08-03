import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeCanonicalGenesisDoc } from "@/lib/agent/__tests__/fixtures";
import type { ToolExecutionContext } from "@/lib/agent/toolExecutionContext";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import * as organizationService from "@/lib/organization/service";
import {
	addLocationPropertiesInputSchema,
	addLocationPropertiesTool,
	addOrganizationLevelsInputSchema,
	addOrganizationLevelsTool,
	createLocationToolInputSchema,
	getOrganizationTool,
	moveLocationToolInputSchema,
	setLocationArchivedTool,
	setLocationArchivedToolInputSchema,
	updateLocationPropertyInputSchema,
	updateLocationToolInputSchema,
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
	it("creates a declared parent and child in the same tool call", async () => {
		const ctx = context();
		const doc = makeCanonicalGenesisDoc("Organization", ctx.appId);
		const parentUuid = testUuid("11111111-1111-4111-8111-111111111111");
		const childUuid = testUuid("22222222-2222-4222-8222-222222222222");
		const result = await addOrganizationLevelsTool.execute(
			{
				levels: [
					{
						uuid: parentUuid,
						code: "region",
						name: "Region",
						caseFlow: { workers: "none", ownsCases: false },
						addressBook: { reach: "own-branch" },
					},
					{
						uuid: childUuid,
						code: "facility",
						name: "Facility",
						parentLevelUuid: parentUuid,
						caseFlow: { workers: "none", ownsCases: true },
						addressBook: { reach: "own-branch" },
					},
				],
			},
			ctx,
			doc,
		);

		expect(result.result).toMatchObject({ uuids: [parentUuid, childUuid] });
		expect(result.newDoc.organizationLevels?.[childUuid]).toMatchObject({
			parentLevelUuid: parentUuid,
		});
	});

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

	it("accepts null as absence on add and preserves unique-choice validation", () => {
		expect(
			addOrganizationLevelsInputSchema.safeParse({
				levels: [
					{
						code: "facility",
						name: "Facility",
						description: null,
						parentLevelUuid: null,
						caseFlow: { workers: "none", ownsCases: false },
						addressBook: { reach: "own-branch" },
					},
				],
			}).success,
		).toBe(true);
		expect(
			addLocationPropertiesInputSchema.safeParse({
				properties: [
					{
						slug: "kind",
						label: "Kind",
						required: null,
						choices: null,
						levelUuids: null,
					},
				],
			}).success,
		).toBe(true);
		expect(
			updateLocationPropertyInputSchema.safeParse({
				uuid: testUuid("property"),
				choices: ["Clinic", "Clinic"],
			}).success,
		).toBe(false);
	});

	it("requires parents to appear before children in one add call", async () => {
		const ctx = context();
		const doc = makeCanonicalGenesisDoc("Organization", ctx.appId);
		const parentUuid = testUuid("parent-later");
		const childUuid = testUuid("child-first");
		const result = await addOrganizationLevelsTool.execute(
			{
				levels: [
					{
						uuid: childUuid,
						code: "facility",
						name: "Facility",
						parentLevelUuid: parentUuid,
						caseFlow: { workers: "none", ownsCases: false },
						addressBook: { reach: "own-branch" },
					},
					{
						uuid: parentUuid,
						code: "region",
						name: "Region",
						caseFlow: { workers: "none", ownsCases: false },
						addressBook: { reach: "own-branch" },
					},
				],
			},
			ctx,
			doc,
		);
		expect(result.result).toMatchObject({
			error: expect.stringMatching(/parent.*before/i),
		});
	});

	it("requires an exact revision on every place-row tool write", () => {
		const locationUuid = testUuid("location");
		const levelUuid = testUuid("level");
		expect(
			createLocationToolInputSchema.safeParse({ levelUuid, name: "Clinic" })
				.success,
		).toBe(false);
		expect(
			updateLocationToolInputSchema.safeParse({
				locationUuid,
				expectedRevision: "4",
			}).success,
		).toBe(false);
		expect(
			moveLocationToolInputSchema.safeParse({
				locationUuid,
				parentUuid: null,
			}).success,
		).toBe(false);
		expect(
			setLocationArchivedToolInputSchema.safeParse({
				locationUuid,
				archived: false,
			}).success,
		).toBe(false);
	});

	it("returns a bounded searchable page without custom values by default", async () => {
		const ctx = context();
		const doc = makeCanonicalGenesisDoc("Organization", ctx.appId);
		vi.spyOn(organizationService, "readOrganization").mockResolvedValueOnce({
			revision: "7",
			locations: Array.from({ length: 60 }, (_, index) => ({
				id: testUuid(`location-${index}`),
				levelUuid: testUuid("level"),
				parentId: null,
				siteCode: `clinic_${index}`,
				name: `Clinic ${index}`,
				externalId: null,
				latitude: null,
				longitude: null,
				values: { [testUuid("property")]: "secret" },
				archivedAt: null,
				orderKey: String(index),
			})),
		});
		const result = await getOrganizationTool.execute(
			{ query: "clinic", cursor: 25, limit: 25, includeValues: false },
			ctx,
			doc,
		);
		expect(result.data).toMatchObject({
			revision: "7",
			page: {
				returned: 25,
				matching: 60,
				total: 60,
				complete: false,
				nextCursor: 50,
			},
		});
		const data = result.data as { locations: Record<string, unknown>[] };
		expect(data.locations).toHaveLength(25);
		expect(data.locations[0]).not.toHaveProperty("values");
	});

	it("preflights an archive without writing and binds confirmation to its payload", async () => {
		const ctx = context();
		const doc = makeCanonicalGenesisDoc("Organization", ctx.appId);
		const locationUuid = testUuid("archive-location");
		const impact = {
			revision: "9" as const,
			locationIds: [locationUuid],
			unassignedPersonas: [],
			ownedCases: 2,
			blockingOwnerRuleForms: [],
		};
		vi.spyOn(
			organizationService,
			"describeArchiveImpact",
		).mockResolvedValueOnce(impact);
		const write = vi
			.spyOn(organizationService, "setLocationArchived")
			.mockResolvedValueOnce({
				revision: "10",
				archivedIds: [locationUuid],
				unassignedPersonas: [],
				impact,
			});

		const preflight = await setLocationArchivedTool.execute(
			{
				locationUuid,
				archived: true,
				expectedRevision: "9",
				confirm: false,
			},
			ctx,
			doc,
		);
		expect(preflight).toMatchObject({
			kind: "read",
			data: { confirmationRequired: true, impact },
		});
		expect(write).not.toHaveBeenCalled();

		await setLocationArchivedTool.execute(
			{
				locationUuid,
				archived: true,
				expectedRevision: "9",
				confirm: true,
				confirmedImpact: impact,
			},
			ctx,
			doc,
		);
		expect(write).toHaveBeenCalledWith(
			expect.anything(),
			locationUuid,
			true,
			"9",
			impact,
		);
	});
});
