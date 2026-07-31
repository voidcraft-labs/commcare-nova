import { describe, expect, it } from "vitest";
import {
	MAX_CASE_SCALAR_TEXT_LENGTH,
	normalizeCaseScalarTextValue,
	prepareCaseScalarTextValue,
} from "@/lib/domain";

const JAVA_TRIM_BOUNDARY = Array.from({ length: 0x21 }, (_, codeUnit) =>
	String.fromCharCode(codeUnit),
).join("");

describe("case scalar text", () => {
	it("removes every boundary code unit U+0000 through U+0020 and preserves the interior", () => {
		expect(
			normalizeCaseScalarTextValue(
				`${JAVA_TRIM_BOUNDARY}Alice${JAVA_TRIM_BOUNDARY} B.${JAVA_TRIM_BOUNDARY}`,
			),
		).toBe(`Alice${JAVA_TRIM_BOUNDARY} B.`);
	});

	it("does not broaden Java String.trim to punctuation or Unicode whitespace", () => {
		expect(normalizeCaseScalarTextValue("!\u00a0Alice\u00a0!")).toBe(
			"!\u00a0Alice\u00a0!",
		);
	});

	it("distinguishes a blank external ID write from a rejected blank case name", () => {
		expect(prepareCaseScalarTextValue(JAVA_TRIM_BOUNDARY, "allow")).toEqual({
			ok: true,
			value: "",
		});
		expect(prepareCaseScalarTextValue(JAVA_TRIM_BOUNDARY, "reject")).toEqual({
			ok: false,
			value: "",
			reason: "blank",
		});
	});

	it("counts the 255-unit cap in UTF-16 code units", () => {
		const exactly255 = `${"😀".repeat(127)}x`;
		expect(exactly255.length).toBe(MAX_CASE_SCALAR_TEXT_LENGTH);
		expect(prepareCaseScalarTextValue(exactly255, "reject")).toEqual({
			ok: true,
			value: exactly255,
		});

		const tooLong = "😀".repeat(128);
		expect(tooLong.length).toBe(MAX_CASE_SCALAR_TEXT_LENGTH + 1);
		expect(prepareCaseScalarTextValue(tooLong, "allow")).toEqual({
			ok: false,
			value: tooLong,
			reason: "too-long",
		});
	});
});
