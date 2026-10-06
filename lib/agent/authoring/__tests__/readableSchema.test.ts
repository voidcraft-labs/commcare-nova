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

it("states a shared scalar narrowed at one use as a single schema, and keeps a narrowing it cannot merge", () => {
	const positive = { $ref: "#/definitions/Positive" };
	const schema = {
		$schema: "http://json-schema.org/draft-07/schema#",
		type: "object",
		properties: {
			first: positive,
			second: positive,
			third: positive,
			fourth: positive,
			hours: {
				description: "Hours until it expires",
				allOf: [positive],
				maximum: 168,
			},
			floor: { allOf: [positive], exclusiveMinimum: 10, maximum: 20 },
			code: { allOf: [{ $ref: "#/definitions/Code" }], pattern: "^B" },
			other: { $ref: "#/definitions/Code" },
			noted: {
				allOf: [{ ...positive, description: "A count" }],
				maximum: 5,
			},
		},
		additionalProperties: false,
		definitions: {
			Positive: {
				type: "integer",
				exclusiveMinimum: 0,
				maximum: 9007199254740991,
			},
			Code: { type: "string", pattern: "^[A-Z]+$" },
		},
	};
	const readable = readableToolSchema(schema);
	expect(readable.properties).toMatchObject({
		first: positive,
		hours: {
			type: "integer",
			exclusiveMinimum: 0,
			maximum: 168,
			description: "Hours until it expires",
		},
		floor: { type: "integer", exclusiveMinimum: 10, maximum: 20 },
		code: { allOf: [expect.anything()], pattern: "^B" },
		// Keywords beside `$ref` are ignored, so the wrapper has to stay.
		noted: { allOf: [expect.anything()], maximum: 5 },
	});
	expect(readable.properties).not.toHaveProperty("hours.allOf");
	expect(readable.properties).not.toHaveProperty("floor.allOf");
	const before = new Ajv({ strict: false }).compile(schema);
	const after = new Ajv({ strict: false }).compile(readable);
	for (const [value, expected] of [
		[{ first: 1, hours: 168, floor: 11, code: "BA" }, true],
		[{ hours: 169 }, false],
		[{ hours: 0 }, false],
		[{ hours: 1.5 }, false],
		[{ floor: 10 }, false],
		[{ floor: 21 }, false],
		[{ first: 0 }, false],
		[{ code: "AB" }, false],
		[{ code: "Ba" }, false],
		[{ noted: 5 }, true],
		[{ noted: 6 }, false],
	] as const) {
		expect(before(value)).toBe(expected);
		expect(after(value)).toBe(expected);
	}
});
