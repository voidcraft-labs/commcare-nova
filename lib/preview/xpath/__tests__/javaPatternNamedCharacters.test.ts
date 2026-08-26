import { describe, expect, it } from "vitest";
import { prepareOpenJdk17Pattern } from "../javaPatternNamedCharacters";
import { openJdk17CodePointOf } from "../vendor/javaPatternNames.generated";

describe("OpenJDK 17 named characters", () => {
	it("resolves explicit and algorithmic JDK 17 names", () => {
		expect(openJdk17CodePointOf("LATIN CAPITAL LETTER A")).toBe(0x41);
		expect(openJdk17CodePointOf("latin capital letter a")).toBe(0x41);
		expect(openJdk17CodePointOf("CJK UNIFIED IDEOGRAPHS 4E00")).toBe(0x4e00);
		expect(openJdk17CodePointOf("LATIN  CAPITAL LETTER A")).toBeUndefined();
	});

	it("lowers active names while preserving quoted and escaped text", async () => {
		await expect(
			prepareOpenJdk17Pattern(
				String.raw`^\N{LATIN CAPITAL LETTER A}\N{CJK UNIFIED IDEOGRAPHS 4E00}$`,
			),
		).resolves.toBe(String.raw`^\x{41}\x{4E00}$`);
		await expect(
			prepareOpenJdk17Pattern(
				String.raw`\Q\N{LATIN CAPITAL LETTER A}\E\\N{LATIN CAPITAL LETTER A}`,
			),
		).resolves.toBe(
			String.raw`\Q\N{LATIN CAPITAL LETTER A}\E\\N{LATIN CAPITAL LETTER A}`,
		);
	});

	it("leaves unknown and incomplete names for Pattern to reject", async () => {
		await expect(
			prepareOpenJdk17Pattern(String.raw`\N{PRIVATE APP VALUE}`),
		).resolves.toBe(String.raw`\N{PRIVATE APP VALUE}`);
		await expect(
			prepareOpenJdk17Pattern(String.raw`\N{LATIN CAPITAL LETTER A`),
		).resolves.toBe(String.raw`\N{LATIN CAPITAL LETTER A`);
	});
});
