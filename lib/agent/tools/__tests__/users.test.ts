import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { eq, literal, sessionUserProperty } from "@/lib/domain/predicate";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import {
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

function makeCtx() {
	const recordMutations = vi.fn(
		async (_mutations: Mutation[], doc: BlueprintDoc) => ({
			events: [],
			committedDoc: doc,
		}),
	);
	const ctx = {
		appId: "app-users",
		projectId: "project-users",
		userId: "member",
		runId: "run",
		recordMutations,
		recordMutationStages: vi.fn(),
		recordConversation: vi.fn(),
	} as unknown as ToolExecutionContext;
	return { ctx, recordMutations };
}

function emptyDoc(): BlueprintDoc {
	return buildDoc({ appName: "Users", modules: [] });
}

describe("user authoring tools", () => {
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

	it("states that update values replace the complete saved set", () => {
		for (const schema of [
			updateUserTypeInputSchema,
			updatePersonaInputSchema,
		]) {
			const json = z.toJSONSchema(schema, {
				target: "draft-7",
				io: "input",
			}) as {
				properties?: { values?: { description?: string } };
			};
			expect(json.properties?.values?.description).toContain(
				"COMPLETE replacement",
			);
			expect(json.properties?.values?.description).toContain(
				"include every value",
			);
		}
		expect(updateUserTypeTool.description).toContain("COMPLETE replacement");
		expect(updatePersonaTool.description).toContain("COMPLETE replacement");
	});

	it("bridges returned property uuids into role and persona value records", async () => {
		const { ctx } = makeCtx();
		const propertyResult = await addUserPropertiesTool.execute(
			{
				properties: [
					{
						slug: "region",
						label: "Region",
						choices: ["north", "south"],
					},
				],
			},
			ctx,
			emptyDoc(),
		);
		if (!("uuids" in propertyResult.result)) {
			throw new Error("property creation unexpectedly failed");
		}
		const propertyUuid = propertyResult.result.uuids[0];

		const roleResult = await addUserTypesTool.execute(
			{
				userTypes: [
					{
						name: "Community health worker",
						values: [{ userPropertyUuid: propertyUuid, value: "north" }],
					},
				],
			},
			ctx,
			propertyResult.newDoc,
		);
		if (!("uuids" in roleResult.result)) {
			throw new Error("role creation unexpectedly failed");
		}
		const roleUuid = roleResult.result.uuids[0];
		expect(roleResult.newDoc.userTypes?.[roleUuid]?.values).toEqual({
			[propertyUuid]: "north",
		});

		const personaResult = await addPersonasTool.execute(
			{
				personas: [
					{
						name: "Asha",
						userTypeUuid: roleUuid,
						values: [{ userPropertyUuid: propertyUuid, value: "south" }],
					},
				],
			},
			ctx,
			roleResult.newDoc,
		);
		if (!("uuids" in personaResult.result)) {
			throw new Error("persona creation unexpectedly failed");
		}
		const personaUuid = personaResult.result.uuids[0];
		expect(personaResult.newDoc.personas?.[personaUuid]).toMatchObject({
			userTypeUuid: roleUuid,
			values: { [propertyUuid]: "south" },
		});

		const read = await getUsersTool.execute({}, ctx, personaResult.newDoc);
		expect(read.data.roles[0]?.values).toEqual([
			{ userPropertyUuid: propertyUuid, slug: "region", value: "north" },
		]);
		expect(read.data.personas[0]?.values).toEqual([
			{ userPropertyUuid: propertyUuid, slug: "region", value: "south" },
		]);
	});

	it("uses null only as an explicit clear and keeps omitted slots unchanged", async () => {
		const { ctx } = makeCtx();
		const nullableAdd = await addUserPropertiesTool.execute(
			{
				properties: [
					{
						slug: "district",
						label: "District",
						required: null,
						choices: null,
					},
				],
			},
			ctx,
			emptyDoc(),
		);
		if (!("uuids" in nullableAdd.result)) throw new Error("setup failed");
		expect(
			nullableAdd.newDoc.userProperties?.[nullableAdd.result.uuids[0]],
		).toEqual(
			expect.objectContaining({
				slug: "district",
				label: "District",
			}),
		);
		expect(
			nullableAdd.newDoc.userProperties?.[nullableAdd.result.uuids[0]],
		).not.toHaveProperty("required");
		expect(
			nullableAdd.newDoc.userProperties?.[nullableAdd.result.uuids[0]],
		).not.toHaveProperty("choices");

		const property = await addUserPropertiesTool.execute(
			{ properties: [{ slug: "region", label: "Region", required: true }] },
			ctx,
			emptyDoc(),
		);
		if (!("uuids" in property.result)) throw new Error("setup failed");
		const propertyUuid = property.result.uuids[0];
		const role = await addUserTypesTool.execute(
			{
				userTypes: [
					{
						name: "CHW",
						description: "Visits households",
						values: [{ userPropertyUuid: propertyUuid, value: "north" }],
					},
				],
			},
			ctx,
			property.newDoc,
		);
		if (!("uuids" in role.result)) throw new Error("setup failed");
		const roleUuid = role.result.uuids[0];

		const cleared = await updateUserTypeTool.execute(
			{ uuid: roleUuid, description: null, values: null },
			ctx,
			role.newDoc,
		);
		expect(cleared.newDoc.userTypes?.[roleUuid]).toMatchObject({ name: "CHW" });
		expect(cleared.newDoc.userTypes?.[roleUuid]).not.toHaveProperty(
			"description",
		);
		expect(cleared.newDoc.userTypes?.[roleUuid]).not.toHaveProperty("values");

		const propertyCleared = await updateUserPropertyTool.execute(
			{ uuid: propertyUuid, required: null },
			ctx,
			cleared.newDoc,
		);
		expect(
			propertyCleared.newDoc.userProperties?.[propertyUuid],
		).not.toHaveProperty("required");
		expect(propertyCleared.newDoc.userProperties?.[propertyUuid]?.label).toBe(
			"Region",
		);
	});

	it("rejects duplicate roles atomically and preserves a refused accepted-value edit", async () => {
		const { ctx, recordMutations } = makeCtx();
		const duplicate = await addUserTypesTool.execute(
			{ userTypes: [{ name: "CHW" }, { name: " chw " }] },
			ctx,
			emptyDoc(),
		);
		expect(duplicate.result).toMatchObject({
			error: expect.stringContaining("role"),
		});
		expect(recordMutations).not.toHaveBeenCalled();

		const property = await addUserPropertiesTool.execute(
			{
				properties: [
					{ slug: "region", label: "Region", choices: ["north", "south"] },
				],
			},
			ctx,
			emptyDoc(),
		);
		if (!("uuids" in property.result)) throw new Error("setup failed");
		const propertyUuid = property.result.uuids[0];
		const role = await addUserTypesTool.execute(
			{
				userTypes: [
					{
						name: "CHW",
						values: [{ userPropertyUuid: propertyUuid, value: "south" }],
					},
				],
			},
			ctx,
			property.newDoc,
		);
		const narrowed = await updateUserPropertyTool.execute(
			{ uuid: propertyUuid, choices: ["north"] },
			ctx,
			role.newDoc,
		);
		expect(narrowed.result).toMatchObject({
			error: expect.stringContaining("south"),
		});
		expect(narrowed.newDoc).toBe(role.newDoc);
	});

	it("removes a property and every UUID-keyed value in one batch, while held roles refuse removal", async () => {
		const { ctx } = makeCtx();
		const property = await addUserPropertiesTool.execute(
			{ properties: [{ slug: "region", label: "Region" }] },
			ctx,
			emptyDoc(),
		);
		if (!("uuids" in property.result)) throw new Error("setup failed");
		const propertyUuid = property.result.uuids[0];
		const role = await addUserTypesTool.execute(
			{
				userTypes: [
					{
						name: "CHW",
						values: [{ userPropertyUuid: propertyUuid, value: "north" }],
					},
				],
			},
			ctx,
			property.newDoc,
		);
		if (!("uuids" in role.result)) throw new Error("setup failed");
		const roleUuid = role.result.uuids[0];
		const persona = await addPersonasTool.execute(
			{
				personas: [
					{
						name: "Asha",
						userTypeUuid: roleUuid,
						values: [{ userPropertyUuid: propertyUuid, value: "south" }],
					},
				],
			},
			ctx,
			role.newDoc,
		);

		const held = await removeUserTypeTool.execute(
			{ uuid: roleUuid },
			ctx,
			persona.newDoc,
		);
		expect(held.result).toMatchObject({
			error: expect.stringContaining("Asha"),
		});
		expect(held.newDoc).toBe(persona.newDoc);

		const removed = await removeUserPropertyTool.execute(
			{ uuid: propertyUuid },
			ctx,
			persona.newDoc,
		);
		expect(removed.newDoc.userProperties).toBeUndefined();
		expect(removed.newDoc.userTypes?.[roleUuid]).not.toHaveProperty("values");
		expect(Object.values(removed.newDoc.personas ?? {})[0]).not.toHaveProperty(
			"values",
		);
		expect(removed.mutations.at(-1)).toEqual({
			kind: "removeUserProperty",
			uuid: propertyUuid,
		});
	});

	it("refuses to remove referenced worker information without committing", async () => {
		const propertyUuid = asUuid("worker-region");
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					displayCondition: eq(
						sessionUserProperty(propertyUuid),
						literal("north"),
					),
				},
			],
		});
		doc.userProperties = {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "region",
				label: "Region",
			},
		};
		const { ctx, recordMutations } = makeCtx();

		const result = await removeUserPropertyTool.execute(
			{ uuid: propertyUuid },
			ctx,
			doc,
		);

		expect(result.newDoc).toBe(doc);
		expect(result.mutations).toEqual([]);
		expect(result.result).toEqual({
			error: expect.stringContaining(
				"Update or remove that reference before removing",
			),
		});
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("updates and removes a persona by UUID, then allows its unreferenced role to be removed", async () => {
		const { ctx } = makeCtx();
		const role = await addUserTypesTool.execute(
			{ userTypes: [{ name: "CHW" }] },
			ctx,
			emptyDoc(),
		);
		if (!("uuids" in role.result)) throw new Error("setup failed");
		const roleUuid = role.result.uuids[0];
		const persona = await addPersonasTool.execute(
			{
				personas: [
					{
						name: "Asha",
						description: "South district",
						userTypeUuid: roleUuid,
					},
				],
			},
			ctx,
			role.newDoc,
		);
		if (!("uuids" in persona.result)) throw new Error("setup failed");
		const personaUuid = persona.result.uuids[0];

		const updated = await updatePersonaTool.execute(
			{
				uuid: personaUuid,
				name: "Asha N.",
				description: null,
				userTypeUuid: null,
			},
			ctx,
			persona.newDoc,
		);
		expect(updated.newDoc.personas?.[personaUuid]).toMatchObject({
			uuid: personaUuid,
			name: "Asha N.",
		});
		expect(updated.newDoc.personas?.[personaUuid]).not.toHaveProperty(
			"description",
		);
		expect(updated.newDoc.personas?.[personaUuid]).not.toHaveProperty(
			"userTypeUuid",
		);

		const removedPersona = await removePersonaTool.execute(
			{ uuid: personaUuid },
			ctx,
			updated.newDoc,
		);
		expect(removedPersona.newDoc.personas).toBeUndefined();
		expect(removedPersona.mutations).toEqual([
			{ kind: "removePersona", uuid: personaUuid },
		]);

		const removedRole = await removeUserTypeTool.execute(
			{ uuid: roleUuid },
			ctx,
			removedPersona.newDoc,
		);
		expect(removedRole.newDoc.userTypes).toBeUndefined();
		expect(removedRole.mutations).toEqual([
			{ kind: "removeUserType", uuid: roleUuid },
		]);
	});

	it("emits one shared mutation per changed role value", async () => {
		const { ctx } = makeCtx();
		const properties = await addUserPropertiesTool.execute(
			{
				properties: [
					{ slug: "region", label: "Region" },
					{ slug: "cadre", label: "Cadre" },
				],
			},
			ctx,
			emptyDoc(),
		);
		if (!("uuids" in properties.result)) throw new Error("setup failed");
		const [regionUuid, cadreUuid] = properties.result.uuids;
		const role = await addUserTypesTool.execute(
			{
				userTypes: [
					{
						name: "CHW",
						values: [
							{ userPropertyUuid: regionUuid, value: "north" },
							{ userPropertyUuid: cadreUuid, value: "community" },
						],
					},
				],
			},
			ctx,
			properties.newDoc,
		);
		if (!("uuids" in role.result)) throw new Error("setup failed");

		const updated = await updateUserTypeTool.execute(
			{
				uuid: role.result.uuids[0],
				values: [
					{ userPropertyUuid: regionUuid, value: "south" },
					{ userPropertyUuid: cadreUuid, value: "supervisor" },
				],
			},
			ctx,
			role.newDoc,
		);

		expect(updated.mutations).toHaveLength(2);
		expect(
			updated.mutations.map((mutation) =>
				"valuePatch" in mutation ? mutation.valuePatch : undefined,
			),
		).toEqual(
			[
				{ userPropertyUuid: cadreUuid, value: "supervisor" },
				{ userPropertyUuid: regionUuid, value: "south" },
			].sort((a, b) => a.userPropertyUuid.localeCompare(b.userPropertyUuid)),
		);
	});

	it("treats a provided values array as the complete replacement", async () => {
		const { ctx } = makeCtx();
		const properties = await addUserPropertiesTool.execute(
			{
				properties: [
					{ slug: "region", label: "Region" },
					{ slug: "cadre", label: "Cadre" },
				],
			},
			ctx,
			emptyDoc(),
		);
		if (!("uuids" in properties.result)) throw new Error("setup failed");
		const [regionUuid, cadreUuid] = properties.result.uuids;
		const role = await addUserTypesTool.execute(
			{
				userTypes: [
					{
						name: "CHW",
						values: [
							{ userPropertyUuid: regionUuid, value: "north" },
							{ userPropertyUuid: cadreUuid, value: "community" },
						],
					},
				],
			},
			ctx,
			properties.newDoc,
		);
		if (!("uuids" in role.result)) throw new Error("setup failed");

		const updated = await updateUserTypeTool.execute(
			{
				uuid: role.result.uuids[0],
				values: [{ userPropertyUuid: regionUuid, value: "south" }],
			},
			ctx,
			role.newDoc,
		);

		expect(updated.newDoc.userTypes?.[role.result.uuids[0]]?.values).toEqual({
			[regionUuid]: "south",
		});
		expect(
			updated.mutations.some(
				(mutation) =>
					"valuePatch" in mutation &&
					mutation.valuePatch?.userPropertyUuid === cadreUuid &&
					mutation.valuePatch.value === null,
			),
		).toBe(true);
	});

	it.each([
		{ kind: "role", execute: updateUserTypeTool.execute },
		{ kind: "persona", execute: updatePersonaTool.execute },
	])("does not resolve an inherited $kind target", async ({ execute }) => {
		const { ctx, recordMutations } = makeCtx();

		const result = await execute(
			{ uuid: asUuid("constructor"), name: "Forged" },
			ctx,
			emptyDoc(),
		);

		expect(result.result).toMatchObject({
			error: expect.stringContaining("no longer exists"),
		});
		expect(recordMutations).not.toHaveBeenCalled();
	});
});

describe("user tool schemas", () => {
	it("accepts explicit clears but rejects null for required identity and name slots", () => {
		expect(
			updateUserTypeInputSchema.safeParse({
				uuid: "role",
				description: null,
				values: null,
			}).success,
		).toBe(true);
		expect(
			updatePersonaInputSchema.safeParse({
				uuid: "persona",
				userTypeUuid: null,
				values: null,
			}).success,
		).toBe(true);
		expect(
			updateUserPropertyInputSchema.safeParse({
				uuid: "property",
				label: null,
			}).success,
		).toBe(false);
		expect(
			updateUserTypeInputSchema.safeParse({ uuid: "role", name: null }).success,
		).toBe(false);
	});

	it("rejects duplicate value identities instead of silently taking the last one", () => {
		expect(
			updateUserTypeInputSchema.safeParse({
				uuid: "role",
				values: [
					{ userPropertyUuid: "region", value: "north" },
					{ userPropertyUuid: "region", value: "south" },
				],
			}).success,
		).toBe(false);
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
