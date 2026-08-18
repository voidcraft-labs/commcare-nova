import { describe, expect, it } from "vitest";
import type { AppLanguageIdentity } from "@/lib/domain";
import {
	AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES,
	automaticTranslationAvailable,
	automaticTranslationCapability,
	automaticTranslationLaunchLanguage,
} from "@/lib/translation/capabilityPolicy";

function identity(language: string): AppLanguageIdentity {
	return { language };
}

describe("automatic translation launch policy", () => {
	it("contains 57 unique launch languages and enables every distinct pair", () => {
		expect(AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES).toHaveLength(57);
		expect(
			new Set(
				AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES.map((language) => language.code),
			).size,
		).toBe(57);
		let availableDirections = 0;
		for (const source of AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES) {
			for (const target of AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES) {
				if (source.code === target.code) {
					expect(
						automaticTranslationCapability(
							identity(source.code),
							identity(target.code),
						).status,
					).toBe("withheld");
					continue;
				}
				expect(
					automaticTranslationAvailable(
						identity(source.code),
						identity(target.code),
					),
				).toBe(true);
				availableDirections += 1;
			}
		}
		expect(availableDirections).toBe(3_192);
	});

	it("decides availability by the language axis alone", () => {
		expect(
			automaticTranslationLaunchLanguage({ language: "spa", region: "MX" }),
		).toBe("spa");
		expect(
			automaticTranslationLaunchLanguage({ language: "cmn", script: "Hans" }),
		).toBe("cmn");
		expect(
			automaticTranslationAvailable(
				{ language: "eng", region: "GB" },
				{ language: "spa", region: "MX" },
			),
		).toBe(true);
	});

	it("withholds writing-system and regional-convention conversion within one language", () => {
		const hansToHant = automaticTranslationCapability(
			{ language: "cmn", script: "Hans" },
			{ language: "cmn", script: "Hant" },
		);
		expect(hansToHant.status).toBe("withheld");
		expect(hansToHant.explanation).toContain("isn't translation");

		const sameTag = automaticTranslationCapability(
			identity("eng"),
			identity("eng"),
		);
		expect(sameTag.status).toBe("withheld");
		expect(sameTag.explanation).toContain("the same language");
	});

	it("keeps distinct listed varieties as their own launch languages", () => {
		expect(automaticTranslationLaunchLanguage(identity("arz"))).toBe("arz");
		expect(automaticTranslationLaunchLanguage(identity("yue"))).toBe("yue");
		expect(
			automaticTranslationAvailable(identity("arb"), identity("arz")),
		).toBe(true);
		expect(
			automaticTranslationAvailable(identity("yue"), identity("wuu")),
		).toBe(true);
	});

	it("keeps every unlisted language manual and copy only", () => {
		expect(automaticTranslationLaunchLanguage(identity("zul"))).toBeUndefined();
		expect(
			automaticTranslationCapability(identity("eng"), identity("zul")),
		).toMatchObject({ status: "not-evaluated" });
		expect(
			automaticTranslationAvailable(identity("eng"), identity("zul")),
		).toBe(false);
		expect(
			automaticTranslationAvailable(identity("zul"), identity("xho")),
		).toBe(false);
	});
});
