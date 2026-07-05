import { describe, expect, it } from "vitest";
import { getInitials } from "@/lib/utils";

describe("getInitials", () => {
	it("takes the first code point of up to two words, uppercased", () => {
		expect(getInitials("Ann Lee")).toBe("AL");
		expect(getInitials("  bo  ")).toBe("B");
		expect(getInitials("Ann van der Berg")).toBe("AV");
	});

	it("never splits a surrogate pair (non-BMP first characters)", () => {
		// `word[0]` indexes by UTF-16 code unit and would yield a lone high
		// surrogate ("�") for these.
		expect(getInitials("𝕊am Jones")).toBe("𝕊J");
		expect(getInitials("😀 Smith")).toBe("😀S");
		expect(getInitials("😀")).toBe("😀");
	});

	it("falls back to ? for an empty / whitespace-only name", () => {
		expect(getInitials("")).toBe("?");
		expect(getInitials("   ")).toBe("?");
	});
});
