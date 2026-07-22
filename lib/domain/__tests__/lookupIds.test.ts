import { describe, expect, expectTypeOf, it } from "vitest";
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
	it("runtime-parses UUIDv7 and canonicalizes hex casing", () => {
		for (const schema of [
			lookupTableIdSchema,
			lookupColumnIdSchema,
			lookupRowIdSchema,
		]) {
			expect(schema.parse(UUID_V7.toUpperCase())).toBe(UUID_V7);
			expect(
				schema.safeParse("01890f45-0000-4000-8000-000000000001").success,
			).toBe(false);
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
