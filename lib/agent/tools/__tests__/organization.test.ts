import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
	type ToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { CommitReauthError } from "@/lib/db/commitGuard";
import type { BlueprintDoc } from "@/lib/domain";
import * as organizationService from "@/lib/organization/service";
import {
	addLocationPropertiesInputSchema,
	addLocationPropertiesTool,
	addOrganizationLevelsInputSchema,
	addOrganizationLevelsTool,
	createLocationTool,
	createLocationToolInputSchema,
	getOrganizationTool,
	moveLocationToolInputSchema,
	setLocationArchivedTool,
	setLocationArchivedToolInputSchema,
	updateLocationPropertyInputSchema,
	updateLocationToolInputSchema,
	updateOrganizationLevelInputSchema,
} from "../organization";

const APP_ID = "organization-tool-app";

function makeHarness(initialDoc: BlueprintDoc): ToolWorkspaceHarness {
	return makeToolWorkspaceHarness(initialDoc, {
		appId: APP_ID,
		userId: "member",
		runId: "run",
	});
}

describe("organization authoring tools", () => {
	it("creates a declared parent and child in the same tool call", async () => {
		const doc = makeCanonicalGenesisDoc("Organization", APP_ID);
		const h = makeHarness(doc);
		const parentUuid = testUuid("11111111-1111-4111-8111-111111111111");
		const childUuid = testUuid("22222222-2222-4222-8222-222222222222");
		const result = await h.runTool(addOrganizationLevelsTool, {
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
		});

		expect(result.result).toMatchObject({ uuids: [parentUuid, childUuid] });
		expect(h.currentDoc().organizationLevels?.[childUuid]).toMatchObject({
			parentLevelUuid: parentUuid,
		});
	});

	it("creates levels and place-information fields through guarded mutations", async () => {
		const doc = makeCanonicalGenesisDoc("Organization", APP_ID);
		const h = makeHarness(doc);
		const level = await h.runTool(addOrganizationLevelsTool, {
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
		});
		if (!("uuids" in level.result)) throw new Error("level creation failed");
		const levelUuid = level.result.uuids[0];
		expect(h.currentDoc().organizationLevels?.[levelUuid]).toMatchObject({
			code: "facility",
			name: "Facility",
		});

		const property = await h.runTool(addLocationPropertiesTool, {
			properties: [
				{
					slug: "phone",
					label: "Phone",
					levelUuids: [levelUuid],
				},
			],
		});
		if (!("uuids" in property.result)) {
			throw new Error("property creation failed");
		}
		expect(
			h.currentDoc().locationProperties?.[property.result.uuids[0]],
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
		const doc = makeCanonicalGenesisDoc("Organization", APP_ID);
		const h = makeHarness(doc);
		const parentUuid = testUuid("parent-later");
		const childUuid = testUuid("child-first");
		const result = await h.runTool(addOrganizationLevelsTool, {
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
		});
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

	it("treats null create optionals as absence", () => {
		const parsed = createLocationToolInputSchema.parse({
			levelUuid: testUuid("level-null-optionals"),
			name: "Clinic",
			siteCode: null,
			values: null,
			expectedRevision: "0",
		});
		expect(parsed.siteCode).toBeUndefined();
		expect(parsed.values).toEqual({});
	});

	it("returns a bounded searchable page without custom values by default", async () => {
		const doc = makeCanonicalGenesisDoc("Organization", APP_ID);
		const h = makeHarness(doc);
		const snapshot = {
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
		} as const;
		vi.spyOn(organizationService, "readOrganization").mockResolvedValue(
			snapshot,
		);
		const first = await h.runTool(getOrganizationTool, {
			query: "clinic",
			limit: 25,
			includeValues: false,
		});
		const firstPage = first.data as { page: { nextCursor: string } };
		const result = await h.runTool(getOrganizationTool, {
			query: "clinic",
			cursor: firstPage.page.nextCursor,
			limit: 25,
			includeValues: false,
		});
		expect(result.data).toMatchObject({
			revision: "7",
			page: {
				returned: 25,
				matching: 60,
				total: 60,
				complete: false,
				nextCursor: expect.any(String),
			},
		});
		const data = result.data as { locations: Record<string, unknown>[] };
		expect(data.locations).toHaveLength(25);
		expect(data.locations[0]).not.toHaveProperty("values");
	});

	it("bounds levels, place information, and places in one paged stream", async () => {
		const doc = structuredClone(
			makeCanonicalGenesisDoc("Organization", APP_ID),
		);
		const levels = Array.from({ length: 40 }, (_, index) => {
			const uuid = testUuid(`bounded-level-${index}`);
			return {
				uuid,
				code: `level_${index}`,
				name: `Level ${index}`,
				caseFlow: { workers: "none" as const, ownsCases: false },
				addressBook: { reach: "own-branch" as const },
			};
		});
		const properties = Array.from({ length: 40 }, (_, index) => {
			const uuid = testUuid(`bounded-property-${index}`);
			return {
				uuid,
				slug: `property_${index}`,
				label: `Property ${index}`,
			};
		});
		doc.organizationLevels = Object.fromEntries(
			levels.map((level) => [level.uuid, level]),
		);
		doc.organizationLevelOrder = levels.map((level) => level.uuid);
		doc.locationProperties = Object.fromEntries(
			properties.map((property) => [property.uuid, property]),
		);
		doc.locationPropertyOrder = properties.map((property) => property.uuid);
		const locations = Array.from({ length: 40 }, (_, index) => ({
			id: testUuid(`bounded-location-${index}`),
			levelUuid: levels[0].uuid,
			parentId: null,
			siteCode: `clinic_${index}`,
			name: `Clinic ${index}`,
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
			archivedAt: null,
			orderKey: String(index),
		}));
		vi.spyOn(organizationService, "readOrganization").mockResolvedValue({
			revision: "7",
			locations,
		});
		const h = makeHarness(doc);

		let cursor: string | undefined;
		let levelCount = 0;
		let propertyCount = 0;
		let locationCount = 0;
		for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
			const page = await h.runTool(getOrganizationTool, {
				limit: 25,
				...(cursor === undefined ? {} : { cursor }),
			});
			const data = page.data as {
				levels: unknown[];
				placeInformation: unknown[];
				locations: unknown[];
				page: {
					returned: number;
					complete: boolean;
					nextCursor: string | null;
				};
			};
			expect(data.page.returned).toBeLessThanOrEqual(25);
			expect(
				data.levels.length +
					data.placeInformation.length +
					data.locations.length,
			).toBe(data.page.returned);
			levelCount += data.levels.length;
			propertyCount += data.placeInformation.length;
			locationCount += data.locations.length;
			if (data.page.complete) break;
			if (data.page.nextCursor === null) throw new Error("cursor missing");
			cursor = data.page.nextCursor;
		}
		expect({ levelCount, propertyCount, locationCount }).toEqual({
			levelCount: 40,
			propertyCount: 40,
			locationCount: 40,
		});
	});

	it("propagates terminal chat authorization loss from place writers", async () => {
		const doc = makeCanonicalGenesisDoc("Organization", APP_ID);
		const h = makeHarness(doc);
		vi.spyOn(organizationService, "createLocation").mockRejectedValueOnce(
			new CommitReauthError("Project membership changed."),
		);
		await expect(
			h.runTool(createLocationTool, {
				levelUuid: testUuid("terminal-level"),
				name: "Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
				parentId: null,
				expectedRevision: "0",
			}),
		).rejects.toBeInstanceOf(CommitReauthError);
	});

	it("preflights an archive without writing and binds confirmation to its payload", async () => {
		const doc = makeCanonicalGenesisDoc("Organization", APP_ID);
		const h = makeHarness(doc);
		const locationUuid = testUuid("archive-location");
		const impact = {
			revision: "9" as const,
			confirmationToken: "a".repeat(64),
			affectedLocationCount: 1,
			unassignedPersonaCount: 0,
			unassignedPersonaPreview: [],
			ownedCases: 2,
			blockingOwnerRuleFormCount: 0,
			blockingOwnerRuleFormPreview: [],
			blockingAutomationCount: 0,
			blockingAutomationPreview: [],
		};
		vi.spyOn(
			organizationService,
			"describeArchiveImpact",
		).mockResolvedValueOnce(impact);
		const write = vi
			.spyOn(organizationService, "setLocationArchived")
			.mockResolvedValueOnce({
				revision: "10",
				archivedCount: 1,
				unassignedPersonaCount: 0,
				impact,
			});

		const preflight = await h.runTool(setLocationArchivedTool, {
			locationUuid,
			archived: true,
			expectedRevision: "9",
			confirm: false,
		});
		expect(preflight).toMatchObject({
			kind: "read",
			data: {
				confirmationRequired: true,
				expectedRevisionForConfirmation: "9",
				message: expect.stringContaining("expectedRevisionForConfirmation"),
				impact,
			},
		});
		expect(write).not.toHaveBeenCalled();

		await h.runTool(setLocationArchivedTool, {
			locationUuid,
			archived: true,
			expectedRevision: "9",
			confirm: true,
			confirmedImpact: impact,
		});
		expect(write).toHaveBeenCalledWith(
			expect.anything(),
			locationUuid,
			true,
			"9",
			impact,
		);
	});

	it("returns the archive revision at the same result depth on every branch", async () => {
		const doc = makeCanonicalGenesisDoc("Organization", APP_ID);
		const h = makeHarness(doc);
		vi.spyOn(organizationService, "setLocationArchived").mockResolvedValueOnce({
			revision: "11",
			archivedCount: 1,
			unassignedPersonaCount: 0,
		});
		const result = await h.runTool(setLocationArchivedTool, {
			locationUuid: testUuid("unarchive-location"),
			archived: false,
			expectedRevision: "10",
		});
		expect(result).toMatchObject({ kind: "read", data: { revision: "11" } });
		expect((result as { data: unknown }).data).not.toHaveProperty("result");
	});

	it("rejects a continuation cursor after the organization revision changes", async () => {
		const doc = makeCanonicalGenesisDoc("Organization", APP_ID);
		const h = makeHarness(doc);
		const location = {
			id: testUuid("paged-location"),
			levelUuid: testUuid("paged-level"),
			parentId: null,
			siteCode: "clinic",
			name: "Clinic",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
			archivedAt: null,
			orderKey: "1",
		} as const;
		vi.spyOn(organizationService, "readOrganization")
			.mockResolvedValueOnce({
				revision: "7",
				locations: [
					location,
					{ ...location, id: testUuid("paged-location-2") },
				],
			})
			.mockResolvedValueOnce({ revision: "8", locations: [location] });
		const first = await h.runTool(getOrganizationTool, { limit: 1 });
		const cursor = (first.data as { page: { nextCursor: string } }).page
			.nextCursor;
		const second = await h.runTool(getOrganizationTool, { cursor, limit: 1 });
		expect(second.data).toMatchObject({ restart: true, revision: "8" });
	});

	it("rejects a continuation cursor after only the organization shape changes", async () => {
		const doc = makeCanonicalGenesisDoc("Organization", APP_ID);
		const h = makeHarness(doc);
		const location = {
			id: testUuid("blueprint-paged-location"),
			levelUuid: testUuid("blueprint-paged-level"),
			parentId: null,
			siteCode: "clinic",
			name: "Clinic",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
			archivedAt: null,
			orderKey: "1",
		} as const;
		vi.spyOn(organizationService, "readOrganization").mockResolvedValue({
			revision: "7",
			locations: [
				location,
				{ ...location, id: testUuid("blueprint-paged-location-2") },
			],
		});
		const first = await h.runTool(getOrganizationTool, { limit: 1 });
		const cursor = (first.data as { page: { nextCursor: string } }).page
			.nextCursor;
		/* The shape half now comes from the workspace document, so a real
		 * level add — not a bumped sequence — is what moves it between pages. */
		await h.runTool(addOrganizationLevelsTool, {
			levels: [
				{
					uuid: testUuid("blueprint-paged-new-level"),
					code: "district",
					name: "District",
					caseFlow: { workers: "none", ownsCases: false },
					addressBook: { reach: "own-branch" },
				},
			],
		});
		const second = await h.runTool(getOrganizationTool, { cursor, limit: 1 });
		expect(second.data).toMatchObject({ restart: true, revision: "7" });
	});

	it("marks an owner-rule archive preflight blocked instead of confirmable", async () => {
		const doc = makeCanonicalGenesisDoc("Organization", APP_ID);
		const h = makeHarness(doc);
		vi.spyOn(
			organizationService,
			"describeArchiveImpact",
		).mockResolvedValueOnce({
			revision: "9",
			confirmationToken: "b".repeat(64),
			affectedLocationCount: 1,
			unassignedPersonaCount: 0,
			unassignedPersonaPreview: [],
			ownedCases: 0,
			blockingOwnerRuleFormCount: 1,
			blockingOwnerRuleFormPreview: ["Visit"],
			blockingAutomationCount: 0,
			blockingAutomationPreview: [],
		});
		const result = await h.runTool(setLocationArchivedTool, {
			locationUuid: testUuid("blocked-location"),
			archived: true,
			expectedRevision: "9",
		});
		expect(result).toMatchObject({
			data: { blocked: true, confirmationRequired: false },
		});
	});
});
