import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
	type LookupColumnId,
	type LookupRowId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "../lookupIds";

const UUID_V7 = "01890f45-0000-7000-8000-000000000001";

describe("lookup identities", () => {
	it("retains the same canonical UUIDv7 boundary in runtime and exported schemas", () => {
		for (const schema of [
			lookupTableIdSchema,
			lookupColumnIdSchema,
			lookupRowIdSchema,
		]) {
			const exported = z.toJSONSchema(schema);
			expect(exported.type).toBe("string");
			if (typeof exported.pattern !== "string")
				throw new Error("Missing lookup UUID pattern");
			const pattern = new RegExp(exported.pattern);
			for (const variant of ["8", "9", "a", "b"]) {
				const value = `01890f45-0000-7000-${variant}000-000000000001`;
				expect(schema.parse(value)).toBe(value);
				expect(pattern.test(value)).toBe(true);
			}
			for (const value of [
				UUID_V7.toUpperCase(),
				"01890f45-0000-4000-8000-000000000001",
				"01890f45-0000-7000-7000-000000000001",
				`${UUID_V7}\n`,
				` ${UUID_V7}`,
				UUID_V7.replaceAll("-", ""),
				"__proto__",
				"00000000-0000-0000-0000-000000000000",
			]) {
				expect(schema.safeParse(value).success).toBe(false);
				expect(pattern.test(value)).toBe(false);
			}
		}
	});

	it("keeps table, column, and row identities distinct at compile time", () => {
		expectTypeOf(
			lookupTableIdSchema.parse(UUID_V7),
		).toEqualTypeOf<LookupTableId>();
		expectTypeOf(
			lookupColumnIdSchema.parse(UUID_V7),
		).toEqualTypeOf<LookupColumnId>();
		expectTypeOf(lookupRowIdSchema.parse(UUID_V7)).toEqualTypeOf<LookupRowId>();
		expectTypeOf<LookupTableId>().not.toEqualTypeOf<LookupColumnId>();
		expectTypeOf<LookupColumnId>().not.toEqualTypeOf<LookupRowId>();
		expectTypeOf<LookupRowId>().not.toEqualTypeOf<LookupTableId>();
	});
});
