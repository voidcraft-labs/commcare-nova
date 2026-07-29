import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asUuid, uuidSchema } from "../uuid";

const VALID_BY_VERSION = [
	"00000000-0000-1000-8000-000000000001",
	"00000000-0000-2000-9000-000000000002",
	"00000000-0000-3000-a000-000000000003",
	"00000000-0000-4000-b000-000000000004",
	"00000000-0000-5000-8000-000000000005",
	"00000000-0000-6000-9000-000000000006",
	"00000000-0000-7000-a000-000000000007",
	"00000000-0000-8000-b000-000000000008",
] as const;

describe("canonical Nova UUIDs", () => {
	it("accepts lowercase RFC UUID versions 1 through 8", () => {
		for (const value of VALID_BY_VERSION) {
			expect(uuidSchema.parse(value)).toBe(value);
			expect(asUuid(value)).toBe(value);
		}
	});

	it.each([
		["uppercase", VALID_BY_VERSION[3].toUpperCase()],
		["nil", "00000000-0000-0000-0000-000000000000"],
		["max", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
		["non-versioned", "00000000-0000-9000-8000-000000000001"],
		["non-RFC variant", "00000000-0000-4000-7000-000000000001"],
		["compact", "00000000000040008000000000000001"],
		["braced", "{00000000-0000-4000-8000-000000000001}"],
		["short", "module-1"],
	])("rejects %s input rather than normalizing it", (_label, value) => {
		expect(uuidSchema.safeParse(value).success).toBe(false);
		expect(() => asUuid(value)).toThrow();
	});

	it("exports the complete canonical rule to JSON Schema", () => {
		expect(JSON.stringify(z.toJSONSchema(uuidSchema))).toContain(
			"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8]",
		);
	});
});
