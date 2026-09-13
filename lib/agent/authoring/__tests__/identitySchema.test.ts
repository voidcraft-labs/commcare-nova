import { expect, it } from "vitest";
import { z } from "zod";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { uuidSchema } from "@/lib/domain";
import {
	namedIdentityInputs,
	projectNamedIdentitySchemas,
} from "../identitySchema";
import { authoringToolSchema } from "../toolSchema";

it("classifies every reference in the real shared grammar without changing its cached schema", () => {
	for (const { saName, mcpName, tool } of SHARED_TOOL_REGISTRY) {
		expect(
			saName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
		).toBe(mcpName);
		const original = authoringToolSchema(saName, tool.inputSchema).json;
		const before = JSON.stringify(original);
		const projected = structuredClone(
			authoringToolSchema(saName, tool.inputSchema).identitySchema,
		);
		projectNamedIdentitySchemas(saName, projected);
		expect(
			() => z.fromJSONSchema(projected, { registry: z.registry() }),
			saName,
		).not.toThrow();
		expect(JSON.stringify(original), saName).toBe(before);
	}
});

it("widens references where they are used while leaving shared creation IDs strict", () => {
	const canonical = z.toJSONSchema(
		z.object({
			moduleUuid: uuidSchema,
			operations: z.array(
				z.object({
					operationUuid: uuidSchema,
					operation: z.object({ target: z.object({ idFrom: uuidSchema }) }),
				}),
			),
		}),
		{ target: "draft-7", reused: "ref" },
	);
	projectNamedIdentitySchemas("addCaseOperations", canonical);
	const schema = z.fromJSONSchema(canonical, { registry: z.registry() });
	const input = {
		moduleUuid: "Visits",
		operations: [
			{
				operationUuid: "01890f45-0000-7000-8000-000000000001",
				operation: { target: { idFrom: "register_visit" } },
			},
		],
	};
	expect(schema.safeParse(input).success).toBe(true);
	expect(
		schema.safeParse({
			...input,
			operations: [{ ...input.operations[0], operationUuid: "new_visit" }],
		}).success,
	).toBe(false);
});

it("binds keys and nested references throughout a recursive location request", () => {
	const place = z.object({
		levelUuid: uuidSchema,
		values: z.record(uuidSchema, z.string()),
		get descendants() {
			return z.array(place).optional();
		},
	});
	const schema = z.toJSONSchema(place, { target: "draft-7", reused: "ref" });
	const input = {
		levelUuid: "District",
		values: { staff: "8" },
		descendants: [
			{
				levelUuid: "Clinic",
				values: { staff: "2" },
				descendants: [{ levelUuid: "Outreach", values: {} }],
			},
		],
	};
	const references = namedIdentityInputs("createLocation", schema, input);
	expect(references.map(({ family, value }) => [family, value])).toEqual([
		["organization-level", "District"],
		["location-property", "staff"],
		["organization-level", "Clinic"],
		["location-property", "staff"],
		["organization-level", "Outreach"],
	]);
	for (const reference of references)
		reference.replace(
			reference.family === "location-property"
				? "01890f45-0000-7000-8000-000000000001"
				: `resolved-${reference.value}`,
		);
	expect(input.descendants[0].values).toEqual({
		"01890f45-0000-7000-8000-000000000001": "2",
	});
	expect(input.descendants[0].descendants[0].levelUuid).toBe(
		"resolved-Outreach",
	);
});
