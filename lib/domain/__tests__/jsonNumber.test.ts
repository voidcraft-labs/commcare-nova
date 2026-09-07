import { describe, expect, it } from "vitest";
import { timedEventTimingSchema } from "../automations";
import {
	isPersistableJsonNumber,
	persistableJsonIntegerSchema,
	persistableJsonNonnegativeIntegerSchema,
	persistableJsonNumberSchema,
	persistableJsonPositiveIntegerSchema,
	persistableJsonPositiveNumberSchema,
} from "../jsonNumber";
import { columnSortSchema, tileCellSchema } from "../modules";
import { literalSchema } from "../predicate/types";

const schemas = [
	persistableJsonNumberSchema,
	persistableJsonIntegerSchema,
	persistableJsonNonnegativeIntegerSchema,
	persistableJsonPositiveIntegerSchema,
	persistableJsonPositiveNumberSchema,
];

describe("persistable JSON numbers", () => {
	it.each([
		[0, [true, true, true, false, false]],
		[-1, [true, true, false, false, false]],
		[1, [true, true, true, true, true]],
		[0.1, [true, false, false, false, true]],
		[-1.5, [true, false, false, false, false]],
		[Number.MIN_VALUE, [true, false, false, false, true]],
		[-Number.MIN_VALUE, [true, false, false, false, false]],
		[Number.MAX_SAFE_INTEGER, [true, true, true, true, true]],
		[Number.MIN_SAFE_INTEGER, [true, true, false, false, false]],
	] as const)(
		"preserves %s through the admitted ranges and a real JSON round trip",
		(value, admitted) => {
			expect(isPersistableJsonNumber(value)).toBe(true);
			for (const [index, schema] of schemas.entries()) {
				const result = schema.safeParse(value);
				expect(result.success).toBe(admitted[index]);
				if (result.success) {
					expect(result.data).toBe(value);
					expect(JSON.parse(JSON.stringify({ value: result.data })).value).toBe(
						value,
					);
				}
			}
		},
	);

	it.each([
		NaN,
		Infinity,
		-Infinity,
		-0,
		Number.MAX_SAFE_INTEGER + 1,
		Number.MIN_SAFE_INTEGER - 1,
		Number.MAX_VALUE,
	])("rejects lossy or unsafe %s in every range", (value) => {
		expect(isPersistableJsonNumber(value)).toBe(false);
		for (const schema of schemas)
			expect(schema.safeParse(value).success).toBe(false);
	});

	it.each([undefined, null, "1", false, {}, [], BigInt(1)])(
		"does not coerce %s into a stored number",
		(value) => {
			for (const schema of schemas)
				expect(schema.safeParse(value).success).toBe(false);
		},
	);

	it("retains number admission when schemas add narrower bounds", () => {
		const schema = persistableJsonNumberSchema.min(-2).max(2);
		for (const value of [-2, -0.5, 0, 0.5, 2])
			expect(schema.parse(value)).toBe(value);
		for (const value of [-2.1, 2.1, -0, NaN, Infinity])
			expect(schema.safeParse(value).success).toBe(false);
	});

	it("executes numeric admission through nested literal, sort, tile and automation schemas", () => {
		const consumers = [
			(value: number) => literalSchema.safeParse({ kind: "literal", value }),
			(value: number) =>
				columnSortSchema.safeParse({ direction: "asc", priority: value }),
			(value: number) =>
				tileCellSchema.safeParse({ x: 0, y: 0, width: value, height: 1 }),
			(value: number) =>
				timedEventTimingSchema.safeParse({
					kind: "random-window",
					time: "08:00",
					windowMinutes: value,
				}),
		];
		for (const parse of consumers) {
			expect(parse(1).success).toBe(true);
			for (const value of [-0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
				expect(parse(value).success).toBe(false);
		}
	});
});
