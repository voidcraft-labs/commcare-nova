import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, withUserSequences } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { eq, literal, sessionUserProperty } from "@/lib/domain/predicate";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "../../__tests__/fixtures";
import {
	addPersonasInputSchema,
	addPersonasTool,
	addUserPropertiesInputSchema,
	addUserPropertiesTool,
	addUserTypesTool,
	getUsersTool,
	removePersonaTool,
	removeUserPropertyTool,
	removeUserTypeTool,
	updatePersonaInputSchema,
	updatePersonaTool,
	updateUserPropertyInputSchema,
	updateUserPropertyTool,
	updateUserTypeInputSchema,
	updateUserTypeTool,
} from "../users";

function makeHarness(doc: BlueprintDoc) {
	return makeToolWorkspaceHarness(doc, {
		appId: "app-users",
		userId: "member",
		runId: "run",
	});
}

function emptyDoc(): BlueprintDoc {
	return makeCanonicalGenesisDoc("Users", "app-users");
}

describe("user authoring tools", () => {
	it("keeps persona place assignments unique and primary-first", async () => {
		const first = testUuid("persona-place-first");
		const second = testUuid("persona-place-second");
		expect(
			addPersonasInputSchema.safeParse({
				personas: [{ name: "Asha", locationUuids: [first, first] }],
			}).success,
		).toBe(false);

		const harness = makeHarness(emptyDoc());
		const added = await harness.runTool(addPersonasTool, {
			personas: [{ name: "Asha", locationUuids: [first, second] }],
		});
		if (!("uuids" in added.result)) throw new Error("persona creation failed");
		expect(
			harness.currentDoc().personas?.[added.result.uuids[0]]?.locations,
		).toEqual({
			primaryUuid: first,
			additionalUuids: [second],
		});
		const read = await harness.runTool(getUsersTool, {});
		expect(read.data.personas[0]?.locationUuids).toEqual([first, second]);
		expect(read.data.personas[0]).not.toHaveProperty("locations");
		expect(
			updatePersonaInputSchema.safeParse({
				uuid: added.result.uuids[0],
				locationUuids: read.data.personas[0]?.locationUuids,
			}).success,
		).toBe(true);
	});

	it("uses the same XML-safe worker-property grammar on the SA and MCP schema", () => {
		for (const slug of ["2fa_region", "-area"]) {
			expect(
				addUserPropertiesInputSchema.safeParse({
					properties: [{ slug, label: "Invalid" }],
				}).success,
				slug,
			).toBe(false);
		}
		expect(
			addUserPropertiesInputSchema.safeParse({
				properties: [{ slug: "district-code", label: "District code" }],
			}).success,
		).toBe(true);
	});

	it("states the initial-build ordering contract at the tool boundary", () => {
		expect(addUserPropertiesTool.description).toContain("immediately after");
		expect(addUserPropertiesTool.description).toContain("before");
		expect(addUserPropertiesTool.description).toContain("createModule");
	});

	it("states that each update carries one UUID-addressed value patch", () => {
		for (const schema of [
			updateUserTypeInputSchema,
			updatePersonaInputSchema,
		]) {
			const json = z.toJSONSchema(schema, {
				target: "draft-7",
				io: "input",
			}) as {
				properties?: { valuePatch?: { description?: string } };
			};
			expect(json.properties?.valuePatch?.description).toContain(
				"One UUID-addressed value edit",
			);
			expect(json.properties?.valuePatch?.description).toContain(
				"clear only the named property",
			);
		}
		expect(updateUserTypeTool.description).toContain("valuePatch");
		expect(updatePersonaTool.description).toContain("valuePatch");
	});

	it("bridges returned property uuids into role and persona value records", async () => {
		const harness = makeHarness(emptyDoc());
		const propertyResult = await harness.runTool(addUserPropertiesTool, {
			properties: [
				{
					slug: "region",
					label: "Region",
					choices: ["north", "south"],
				},
			],
		});
		if (!("uuids" in propertyResult.result)) {
			throw new Error("property creation unexpectedly failed");
		}
		const propertyUuid = propertyResult.result.uuids[0];

		const roleResult = await harness.runTool(addUserTypesTool, {
			userTypes: [
				{
					name: "Community health worker",
					values: [{ userPropertyUuid: propertyUuid, value: "north" }],
				},
			],
		});
		if (!("uuids" in roleResult.result)) {
			throw new Error("role creation unexpectedly failed");
		}
		const roleUuid = roleResult.result.uuids[0];
		expect(harness.currentDoc().userTypes?.[roleUuid]?.values).toEqual({
			[propertyUuid]: "north",
		});

		const personaResult = await harness.runTool(addPersonasTool, {
			personas: [
				{
					name: "Asha",
					userTypeUuid: roleUuid,
					values: [{ userPropertyUuid: propertyUuid, value: "south" }],
				},
			],
		});
		if (!("uuids" in personaResult.result)) {
			throw new Error("persona creation unexpectedly failed");
		}
		const personaUuid = personaResult.result.uuids[0];
		expect(harness.currentDoc().personas?.[personaUuid]).toMatchObject({
			userTypeUuid: roleUuid,
			values: { [propertyUuid]: "south" },
		});

		const read = await harness.runTool(getUsersTool, {});
		expect(read.data.roles[0]?.values).toEqual([
			{ userPropertyUuid: propertyUuid, value: "north" },
		]);
		expect(read.data.personas[0]?.values).toEqual([
			{ userPropertyUuid: propertyUuid, value: "south" },
		]);
		expect(Object.keys(read.data.roles[0]?.values[0] ?? {}).sort()).toEqual([
			"userPropertyUuid",
			"value",
		]);
		expect(read.data.workerInformation[0]).toMatchObject({
			uuid: propertyUuid,
			slug: "region",
		});
	});

	it("honors predeclared identities while retaining server-minted defaults", async () => {
		const harness = makeHarness(emptyDoc());
		const propertyUuid = testUuid("declared-worker-property");
		const userTypeUuid = testUuid("declared-user-type");
		const personaUuid = testUuid("declared-persona");

		const property = await harness.runTool(addUserPropertiesTool, {
			properties: [
				{
					userPropertyUuid: propertyUuid,
					slug: "program",
					label: "Program",
				},
			],
		});
		const role = await harness.runTool(addUserTypesTool, {
			userTypes: [
				{
					userTypeUuid,
					name: "Coordinator",
					values: [{ userPropertyUuid: propertyUuid, value: "coord" }],
				},
			],
		});
		const persona = await harness.runTool(addPersonasTool, {
			personas: [
				{
					personaUuid,
					name: "Amina",
					userTypeUuid,
				},
			],
		});

		expect(property.result).toMatchObject({ uuids: [propertyUuid] });
		expect(role.result).toMatchObject({ uuids: [userTypeUuid] });
		expect(persona.result).toMatchObject({ uuids: [personaUuid] });
		expect(harness.currentDoc().personas?.[personaUuid]?.userTypeUuid).toBe(
			userTypeUuid,
		);
	});

	it("uses null only as an explicit clear and keeps omitted slots unchanged", async () => {
		const nullableHarness = makeHarness(emptyDoc());
		const nullableAdd = await nullableHarness.runTool(addUserPropertiesTool, {
			properties: [
				{
					slug: "district",
					label: "District",
					required: null,
					choices: null,
				},
			],
		});
		if (!("uuids" in nullableAdd.result)) throw new Error("setup failed");
		expect(
			nullableHarness.currentDoc().userProperties?.[
				nullableAdd.result.uuids[0]
			],
		).toEqual(
			expect.objectContaining({
				slug: "district",
				label: "District",
			}),
		);
		expect(
			nullableHarness.currentDoc().userProperties?.[
				nullableAdd.result.uuids[0]
			],
		).not.toHaveProperty("required");
		expect(
			nullableHarness.currentDoc().userProperties?.[
				nullableAdd.result.uuids[0]
			],
		).not.toHaveProperty("choices");

		const harness = makeHarness(emptyDoc());
		const property = await harness.runTool(addUserPropertiesTool, {
			properties: [{ slug: "region", label: "Region", required: true }],
		});
		if (!("uuids" in property.result)) throw new Error("setup failed");
		const propertyUuid = property.result.uuids[0];
		const role = await harness.runTool(addUserTypesTool, {
			userTypes: [
				{
					name: "CHW",
					description: "Visits households",
					values: [{ userPropertyUuid: propertyUuid, value: "north" }],
				},
			],
		});
		if (!("uuids" in role.result)) throw new Error("setup failed");
		const roleUuid = role.result.uuids[0];

		await harness.runTool(updateUserTypeTool, {
			uuid: roleUuid,
			description: null,
			valuePatch: { userPropertyUuid: propertyUuid, value: null },
		});
		expect(harness.currentDoc().userTypes?.[roleUuid]).toMatchObject({
			name: "CHW",
		});
		expect(harness.currentDoc().userTypes?.[roleUuid]).not.toHaveProperty(
			"description",
		);
		expect(harness.currentDoc().userTypes?.[roleUuid]).not.toHaveProperty(
			"values",
		);

		await harness.runTool(updateUserPropertyTool, {
			uuid: propertyUuid,
			required: null,
		});
		expect(
			harness.currentDoc().userProperties?.[propertyUuid],
		).not.toHaveProperty("required");
		expect(harness.currentDoc().userProperties?.[propertyUuid]?.label).toBe(
			"Region",
		);
	});

	it("rejects duplicate roles atomically and preserves a refused accepted-value edit", async () => {
		const harness = makeHarness(emptyDoc());
		const duplicate = await harness.runTool(addUserTypesTool, {
			userTypes: [{ name: "CHW" }, { name: " chw " }],
		});
		expect(duplicate.result).toMatchObject({
			error: expect.stringContaining("role"),
		});
		expect(harness.recordMutations).not.toHaveBeenCalled();

		const property = await harness.runTool(addUserPropertiesTool, {
			properties: [
				{ slug: "region", label: "Region", choices: ["north", "south"] },
			],
		});
		if (!("uuids" in property.result)) throw new Error("setup failed");
		const propertyUuid = property.result.uuids[0];
		await harness.runTool(addUserTypesTool, {
			userTypes: [
				{
					name: "CHW",
					values: [{ userPropertyUuid: propertyUuid, value: "south" }],
				},
			],
		});
		const docAfterRole = harness.currentDoc();
		const narrowed = await harness.runTool(updateUserPropertyTool, {
			uuid: propertyUuid,
			choices: ["north"],
		});
		expect(narrowed.result).toMatchObject({
			error: expect.stringContaining("south"),
		});
		expect(harness.currentDoc()).toBe(docAfterRole);
	});

	it("removes a property and every UUID-keyed value in one batch, while held roles refuse removal", async () => {
		const harness = makeHarness(emptyDoc());
		const property = await harness.runTool(addUserPropertiesTool, {
			properties: [{ slug: "region", label: "Region" }],
		});
		if (!("uuids" in property.result)) throw new Error("setup failed");
		const propertyUuid = property.result.uuids[0];
		const role = await harness.runTool(addUserTypesTool, {
			userTypes: [
				{
					name: "CHW",
					values: [{ userPropertyUuid: propertyUuid, value: "north" }],
				},
			],
		});
		if (!("uuids" in role.result)) throw new Error("setup failed");
		const roleUuid = role.result.uuids[0];
		await harness.runTool(addPersonasTool, {
			personas: [
				{
					name: "Asha",
					userTypeUuid: roleUuid,
					values: [{ userPropertyUuid: propertyUuid, value: "south" }],
				},
			],
		});
		const docAfterPersona = harness.currentDoc();

		const held = await harness.runTool(removeUserTypeTool, { uuid: roleUuid });
		expect(held.result).toMatchObject({
			error: expect.stringContaining("Asha"),
		});
		expect(harness.currentDoc()).toBe(docAfterPersona);

		const removed = await harness.runTool(removeUserPropertyTool, {
			uuid: propertyUuid,
		});
		expect(harness.currentDoc().userProperties).toBeUndefined();
		expect(harness.currentDoc().userTypes?.[roleUuid]).not.toHaveProperty(
			"values",
		);
		expect(
			Object.values(harness.currentDoc().personas ?? {})[0],
		).not.toHaveProperty("values");
		expect(removed.mutations.at(-1)).toEqual({
			kind: "removeUserProperty",
			uuid: propertyUuid,
		});
	});

	it("refuses to remove referenced worker information without committing", async () => {
		const propertyUuid = testUuid("worker-region");
		const doc = withUserSequences({
			...buildDoc({
				modules: [
					{
						name: "Patients",
						displayCondition: eq(
							sessionUserProperty(propertyUuid),
							literal("north"),
						),
						forms: [
							{
								name: "Survey",
								type: "survey",
								fields: [f({ id: "note", kind: "text" })],
							},
						],
					},
				],
			}),
			userProperties: {
				[propertyUuid]: {
					uuid: propertyUuid,
					slug: "region",
					label: "Region",
				},
			},
		});
		const harness = makeHarness(doc);

		const result = await harness.runTool(removeUserPropertyTool, {
			uuid: propertyUuid,
		});

		expect(harness.currentDoc()).toBe(doc);
		expect(result.mutations).toEqual([]);
		expect(result.result).toEqual({
			error: expect.stringContaining(
				"Update or remove that reference before removing",
			),
		});
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});

	it("updates and removes a persona by UUID, then allows its unreferenced role to be removed", async () => {
		const harness = makeHarness(emptyDoc());
		const role = await harness.runTool(addUserTypesTool, {
			userTypes: [{ name: "CHW" }],
		});
		if (!("uuids" in role.result)) throw new Error("setup failed");
		const roleUuid = role.result.uuids[0];
		const persona = await harness.runTool(addPersonasTool, {
			personas: [
				{
					name: "Asha",
					description: "South district",
					userTypeUuid: roleUuid,
				},
			],
		});
		if (!("uuids" in persona.result)) throw new Error("setup failed");
		const personaUuid = persona.result.uuids[0];

		await harness.runTool(updatePersonaTool, {
			uuid: personaUuid,
			name: "Asha N.",
			description: null,
			userTypeUuid: null,
		});
		expect(harness.currentDoc().personas?.[personaUuid]).toMatchObject({
			uuid: personaUuid,
			name: "Asha N.",
		});
		expect(harness.currentDoc().personas?.[personaUuid]).not.toHaveProperty(
			"description",
		);
		expect(harness.currentDoc().personas?.[personaUuid]).not.toHaveProperty(
			"userTypeUuid",
		);

		const removedPersona = await harness.runTool(removePersonaTool, {
			uuid: personaUuid,
		});
		expect(harness.currentDoc().personas).toBeUndefined();
		expect(removedPersona.mutations).toEqual([
			{ kind: "removePersona", uuid: personaUuid },
		]);

		const removedRole = await harness.runTool(removeUserTypeTool, {
			uuid: roleUuid,
		});
		expect(harness.currentDoc().userTypes).toBeUndefined();
		expect(removedRole.mutations).toEqual([
			{ kind: "removeUserType", uuid: roleUuid },
		]);
	});

	it("emits one shared mutation per changed role value", async () => {
		const harness = makeHarness(emptyDoc());
		const properties = await harness.runTool(addUserPropertiesTool, {
			properties: [
				{ slug: "region", label: "Region" },
				{ slug: "cadre", label: "Cadre" },
			],
		});
		if (!("uuids" in properties.result)) throw new Error("setup failed");
		const [regionUuid, cadreUuid] = properties.result.uuids;
		const role = await harness.runTool(addUserTypesTool, {
			userTypes: [
				{
					name: "CHW",
					values: [
						{ userPropertyUuid: regionUuid, value: "north" },
						{ userPropertyUuid: cadreUuid, value: "community" },
					],
				},
			],
		});
		if (!("uuids" in role.result)) throw new Error("setup failed");

		const updated = await harness.runTool(updateUserTypeTool, {
			uuid: role.result.uuids[0],
			valuePatch: { userPropertyUuid: regionUuid, value: "south" },
		});

		expect(updated.mutations).toHaveLength(1);
		expect(
			updated.mutations.map((mutation) =>
				"valuePatch" in mutation ? mutation.valuePatch : undefined,
			),
		).toEqual([{ userPropertyUuid: regionUuid, value: "south" }]);
		expect(
			harness.currentDoc().userTypes?.[role.result.uuids[0]]?.values,
		).toEqual({
			[regionUuid]: "south",
			[cadreUuid]: "community",
		});
	});

	it("preserves unmentioned values when one value is patched", async () => {
		const harness = makeHarness(emptyDoc());
		const properties = await harness.runTool(addUserPropertiesTool, {
			properties: [
				{ slug: "region", label: "Region" },
				{ slug: "cadre", label: "Cadre" },
			],
		});
		if (!("uuids" in properties.result)) throw new Error("setup failed");
		const [regionUuid, cadreUuid] = properties.result.uuids;
		const role = await harness.runTool(addUserTypesTool, {
			userTypes: [
				{
					name: "CHW",
					values: [
						{ userPropertyUuid: regionUuid, value: "north" },
						{ userPropertyUuid: cadreUuid, value: "community" },
					],
				},
			],
		});
		if (!("uuids" in role.result)) throw new Error("setup failed");

		const updated = await harness.runTool(updateUserTypeTool, {
			uuid: role.result.uuids[0],
			valuePatch: { userPropertyUuid: regionUuid, value: "south" },
		});

		expect(
			harness.currentDoc().userTypes?.[role.result.uuids[0]]?.values,
		).toEqual({
			[regionUuid]: "south",
			[cadreUuid]: "community",
		});
		expect(
			updated.mutations.some(
				(mutation) =>
					"valuePatch" in mutation &&
					mutation.valuePatch?.userPropertyUuid === cadreUuid &&
					mutation.valuePatch.value === null,
			),
		).toBe(false);
	});

	it.each([
		{ kind: "role", tool: updateUserTypeTool },
		{ kind: "persona", tool: updatePersonaTool },
	])("does not resolve an inherited $kind target", async ({ tool }) => {
		const harness = makeHarness(emptyDoc());

		const result = await harness.runTool(tool, {
			uuid: testUuid("constructor"),
			name: "Forged",
		});

		expect(result.result).toMatchObject({
			error: expect.stringContaining("no longer exists"),
		});
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});
});

describe("user tool schemas", () => {
	it("accepts explicit clears but rejects null for required identity and name slots", () => {
		expect(
			updateUserTypeInputSchema.safeParse({
				uuid: testUuid("role"),
				description: null,
				valuePatch: {
					userPropertyUuid: testUuid("property"),
					value: null,
				},
			}).success,
		).toBe(true);
		expect(
			updatePersonaInputSchema.safeParse({
				uuid: testUuid("persona"),
				userTypeUuid: null,
				valuePatch: {
					userPropertyUuid: testUuid("property"),
					value: null,
				},
			}).success,
		).toBe(true);
		expect(
			updateUserPropertyInputSchema.safeParse({
				uuid: testUuid("property"),
				label: null,
			}).success,
		).toBe(false);
		expect(
			updateUserTypeInputSchema.safeParse({
				uuid: testUuid("role"),
				name: null,
			}).success,
		).toBe(false);
	});

	it("rejects the removed whole-values update dialect", () => {
		expect(
			updateUserTypeInputSchema.safeParse({
				uuid: testUuid("role"),
				values: [{ userPropertyUuid: testUuid("region"), value: "north" }],
			}).success,
		).toBe(false);
		expect(
			updateUserTypeInputSchema.safeParse({
				uuid: testUuid("role"),
				valuePatch: {
					userPropertyUuid: testUuid("region"),
					value: "north",
				},
			}).success,
		).toBe(true);
	});

	it("rejects duplicate accepted values on both create and update", () => {
		expect(
			addUserPropertiesInputSchema.safeParse({
				properties: [
					{
						slug: "region",
						label: "Region",
						choices: ["north", "north"],
					},
				],
			}).success,
		).toBe(false);
		expect(
			updateUserPropertyInputSchema.safeParse({
				uuid: "property",
				choices: ["north", "north"],
			}).success,
		).toBe(false);
	});
});
