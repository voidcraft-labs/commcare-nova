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

const INVALID = [
	VALID_BY_VERSION[3].toUpperCase(),
	"00000000-0000-0000-0000-000000000000",
	"ffffffff-ffff-ffff-ffff-ffffffffffff",
	"00000000-0000-9000-8000-000000000001",
	"00000000-0000-4000-7000-000000000001",
	"00000000000040008000000000000001",
	"{00000000-0000-4000-8000-000000000001}",
	"module-1",
	` ${VALID_BY_VERSION[3]}`,
	`${VALID_BY_VERSION[3]}\n`,
	`${VALID_BY_VERSION[3]}x`,
];

describe("canonical Nova UUIDs", () => {
	it("accepts lowercase RFC UUID versions 1 through 8", () => {
		for (const value of VALID_BY_VERSION) {
			expect(uuidSchema.parse(value)).toBe(value);
			expect(asUuid(value)).toBe(value);
		}
	});

	it.each(INVALID)("rejects %s rather than normalizing it", (value) => {
		expect(uuidSchema.safeParse(value).success).toBe(false);
		expect(() => asUuid(value)).toThrow(z.ZodError);
	});

	it("exports a pattern that admits and refuses the same identity corpus", () => {
		const exported = z.toJSONSchema(uuidSchema);
		expect(exported.type).toBe("string");
		if (typeof exported.pattern !== "string")
			throw new Error("Missing UUID admission pattern");
		const pattern = new RegExp(exported.pattern);
		for (const value of VALID_BY_VERSION)
			expect(pattern.test(value)).toBe(true);
		for (const value of INVALID) expect(pattern.test(value)).toBe(false);
	});
});
