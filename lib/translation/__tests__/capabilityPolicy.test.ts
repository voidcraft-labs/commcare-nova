import { describe, expect, it } from "vitest";
import {
	AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES,
	automaticTranslationAvailable,
	automaticTranslationCapability,
	automaticTranslationLaunchLanguage,
} from "@/lib/translation/capabilityPolicy";

describe("automatic translation launch policy", () => {
	it("contains 57 unique launch identities and enables every distinct pair", () => {
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
						automaticTranslationCapability(source.code, target.code).status,
					).toBe("withheld");
					continue;
				}
				expect(automaticTranslationAvailable(source.code, target.code)).toBe(
					true,
				);
				availableDirections += 1;
			}
		}
		expect(availableDirections).toBe(3_192);
	});

	it.each([
		["en", "eng"],
		["es", "spa"],
		["zh", "cmn"],
		["ar", "arb"],
		["sw", "swh"],
		["fa", "pes"],
		["or", "ory"],
		["ne", "npi"],
		["ms", "zlm"],
		["uz", "uzn"],
	] as const)(
		"resolves CommCare alias %s to launch identity %s",
		(code, identity) => {
			expect(automaticTranslationLaunchLanguage(code)).toBe(identity);
		},
	);

	it("resolves regional suffixes without collapsing distinct listed varieties", () => {
		expect(automaticTranslationLaunchLanguage("es-mx")).toBe("spa");
		expect(automaticTranslationLaunchLanguage("arz")).toBe("arz");
		expect(automaticTranslationLaunchLanguage("zh-yue")).toBe("yue");
		expect(automaticTranslationLaunchLanguage("zh-wuu")).toBe("wuu");
		expect(automaticTranslationAvailable("en-gb", "es-mx")).toBe(true);
		expect(automaticTranslationAvailable("ar", "arz")).toBe(true);
		expect(automaticTranslationAvailable("zh-yue", "zh-wuu")).toBe(true);
		expect(automaticTranslationCapability("en", "eng").status).toBe("withheld");
	});

	it("keeps every unlisted language manual and copy only", () => {
		expect(automaticTranslationLaunchLanguage("zul")).toBeUndefined();
		expect(automaticTranslationCapability("en", "zul")).toMatchObject({
			status: "not-evaluated",
		});
		expect(automaticTranslationAvailable("en", "zul")).toBe(false);
	});
});
