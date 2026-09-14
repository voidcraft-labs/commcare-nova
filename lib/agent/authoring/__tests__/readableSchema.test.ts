import Ajv from "ajv";
import { expect, it } from "vitest";
import { readableToolSchema } from "../readableSchema";

it("keeps argument constraints, recursive structures, and literal data while removing scalar indirection", () => {
	const schema = {
		$schema: "http://json-schema.org/draft-07/schema#",
		type: "object",
		properties: {
			name: {
				description: "Display name",
				allOf: [{ $ref: "#/definitions/Name" }],
			},
			count: { $ref: "#/definitions/Count" },
			limit: { $ref: "#/definitions/Count" },
			note: { $ref: "#/definitions/Nullable" },
			places: { type: "array", items: { $ref: "#/definitions/Place" } },
			literal: { const: { $ref: "#/definitions/Name" } },
		},
		required: ["name", "count", "places"],
		additionalProperties: false,
		definitions: {
			Name: { type: "string", minLength: 1 },
			Count: { type: "integer", minimum: 1, maximum: 100 },
			Nullable: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
			Place: {
				type: "object",
				properties: {
					name: { type: "string", minLength: 1 },
					children: { type: "array", items: { $ref: "#/definitions/Place" } },
				},
				required: ["name"],
				additionalProperties: false,
			},
			Unused: { type: "boolean" },
		},
	};
	const original = structuredClone(schema);
	const readable = readableToolSchema(schema);
	expect(schema).toEqual(original);
	expect(readable.properties).toMatchObject({
		name: { type: "string", minLength: 1, description: "Display name" },
		count: { type: "integer", minimum: 1, maximum: 100 },
		literal: { const: { $ref: "#/definitions/Name" } },
	});
	expect(readable.definitions).not.toHaveProperty("Unused");
	const before = new Ajv({ strict: false }).compile(schema);
	const after = new Ajv({ strict: false }).compile(readable);
	const valid = {
		name: "District",
		count: 2,
		places: [{ name: "North", children: [{ name: "Clinic" }] }],
	};
	for (const [value, expected] of [
		[valid, true],
		[{ ...valid, note: null, literal: { $ref: "#/definitions/Name" } }, true],
		[{ ...valid, name: "" }, false],
		[{ ...valid, count: 0 }, false],
		[{ ...valid, count: 1.5 }, false],
		[{ ...valid, limit: 101 }, false],
		[{ ...valid, note: 1 }, false],
		[{ ...valid, note: "" }, false],
		[
			{ ...valid, places: [{ name: "North", children: [{ name: "" }] }] },
			false,
		],
		[{ ...valid, unknown: true }, false],
		[{ ...valid, literal: "District" }, false],
	] as const) {
		expect(before(value)).toBe(expected);
		expect(after(value)).toBe(expected);
	}
});
