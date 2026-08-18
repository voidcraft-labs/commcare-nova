import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	classicWideningTarget,
	identityIssues,
	isIndividualLivingLanguage,
	languageCodeVerdict,
	languageDirection,
	languageDisplayLabel,
	languageEnglishName,
	languageQualifierLabels,
	macrolanguageMembers,
	macrolanguageName,
	regionChoices,
	scriptChoices,
} from "@/lib/domain/languageRegistry";
import {
	altEnglishLanguageName,
	englishLanguageName,
	languageDescriptor,
	resolvedLanguageDisplayLabel,
	resolvedLanguageEnglishName,
} from "@/lib/domain/languageRegistry/names";

describe("languageCodeVerdict", () => {
	it("accepts an individual living Set 3 code", () => {
		expect(languageCodeVerdict("eng")).toEqual({ kind: "individual-living" });
		expect(isIndividualLivingLanguage("eng")).toBe(true);
	});

	it("classifies a macrolanguage with its members, predominant first", () => {
		const verdict = languageCodeVerdict("zho");
		expect(verdict.kind).toBe("macrolanguage");
		expect(verdict.members?.[0]).toEqual({
			code: "cmn",
			englishName: "Mandarin Chinese",
			endonym: "中文",
		});
		expect(isIndividualLivingLanguage("zho")).toBe(false);
	});

	it("resolves a two-letter alias of an individual language", () => {
		expect(languageCodeVerdict("en")).toEqual({
			kind: "set1-alias",
			resolved: "eng",
		});
	});

	it("resolves a two-letter alias of a macrolanguage to the macro verdict", () => {
		const verdict = languageCodeVerdict("zh");
		expect(verdict.kind).toBe("macrolanguage");
		expect(verdict.resolved).toBe("zho");
		expect(verdict.members?.[0]?.code).toBe("cmn");
	});

	it("names what a non-living code is", () => {
		expect(languageCodeVerdict("lat")).toEqual({
			kind: "non-living",
			typeLabel: "a historical language",
		});
		expect(languageCodeVerdict("epo")).toEqual({
			kind: "non-living",
			typeLabel: "a constructed language",
		});
		expect(isIndividualLivingLanguage("lat")).toBe(false);
	});

	it("returns unknown for unassigned, malformed, and empty input", () => {
		expect(languageCodeVerdict("xxx")).toEqual({ kind: "unknown" });
		expect(languageCodeVerdict("")).toEqual({ kind: "unknown" });
		expect(languageCodeVerdict("EN")).toEqual({ kind: "unknown" });
	});
});

describe("scriptChoices and regionChoices", () => {
	it("lists both writing systems of a branching language with directions", () => {
		const scripts = scriptChoices("kas");
		expect(scripts.map((choice) => choice.script)).toEqual(["Arab", "Deva"]);
		expect(scripts[0]).toEqual({
			script: "Arab",
			label: "Kashmiri (Arabic script)",
			qualifier: "Arabic",
			direction: "rtl",
		});
		expect(scripts[1]?.direction).toBe("ltr");
	});

	it("returns no script choices for a single-script language", () => {
		expect(scriptChoices("eng")).toEqual([]);
		expect(scriptChoices("spa")).toEqual([]);
	});

	it("keys Mandarin's regions by script and offers none without one", () => {
		expect(regionChoices("cmn", "Hans")).toEqual([
			{ region: "CN", label: "China" },
			{ region: "SG", label: "Singapore" },
		]);
		expect(regionChoices("cmn", "Hant").map((choice) => choice.region)).toEqual(
			["TW", "HK", "MO"],
		);
		expect(regionChoices("cmn")).toEqual([]);
	});

	it("derives Spanish's official-status regions, Mexico in and the US out", () => {
		const regions = regionChoices("spa");
		expect(regions).toHaveLength(23);
		const codes = regions.map((choice) => choice.region);
		expect(codes).toContain("MX");
		expect(codes).not.toContain("US");
	});

	it("puts the predominant region first for English", () => {
		const regions = regionChoices("eng");
		expect(regions.length).toBeGreaterThan(0);
		expect(regions[0]?.region).toBe("US");
	});

	it("offers no regions where no meaningful alternatives exist", () => {
		expect(regionChoices("zul")).toEqual([]);
		expect(regionChoices("hne")).toEqual([]);
	});
});

describe("identityIssues", () => {
	it("accepts lawful identities", () => {
		expect(identityIssues({ language: "eng" })).toEqual([]);
		expect(identityIssues({ language: "cmn", script: "Hans" })).toEqual([]);
		expect(identityIssues({ language: "spa", region: "MX" })).toEqual([]);
	});

	it("rejects a macrolanguage naming its members by Set 3 code", () => {
		const issues = identityIssues({ language: "zho" });
		expect(issues).toHaveLength(1);
		expect(issues[0]).toContain("macrolanguage");
		expect(issues[0]).toContain("cmn (Mandarin Chinese)");
	});

	it("rejects a two-letter code naming the Set 3 replacement", () => {
		const issues = identityIssues({ language: "fr" });
		expect(issues[0]).toContain("use fra");
	});

	it("rejects a non-living language as not one workers speak", () => {
		const issues = identityIssues({ language: "lat" });
		expect(issues[0]).toContain("a historical language");
		expect(issues[0]).toContain("living");
	});

	it("rejects an unassigned code pointing at name lookup", () => {
		const issues = identityIssues({ language: "xxx" });
		expect(issues[0]).toContain(
			"not a current ISO 639:2023 Set 3 language identifier",
		);
	});

	it("requires a script choice when the language branches", () => {
		const issues = identityIssues({ language: "cmn" });
		expect(issues[0]).toContain("written in more than one script");
		expect(issues[0]).toContain("Hans (Simplified Chinese)");
	});

	it("rejects a script outside the language's writing systems", () => {
		const issues = identityIssues({ language: "cmn", script: "Latn" });
		expect(issues[0]).toContain("writing systems");
	});

	it("rejects a script on a single-script language", () => {
		const issues = identityIssues({ language: "spa", script: "Latn" });
		expect(issues[0]).toContain("one customary writing system");
	});

	it("rejects a region outside the language's conventions", () => {
		const issues = identityIssues({
			language: "cmn",
			script: "Hans",
			region: "TW",
		});
		expect(issues[0]).toContain("regional conventions");
	});

	it("rejects a region where the language offers none", () => {
		const issues = identityIssues({ language: "zul", region: "ZA" });
		expect(issues[0]).toContain("no regional-convention choices");
	});
});

describe("baked display derivation", () => {
	it("derives endonym, English name, and qualifiers from the identity", () => {
		expect(languageDisplayLabel({ language: "fra" })).toBe("Français");
		expect(languageEnglishName({ language: "fra" })).toBe("French");
		expect(languageQualifierLabels({ language: "fra" })).toEqual([]);

		expect(languageDisplayLabel({ language: "spa", region: "MX" })).toBe(
			"Español de México",
		);
		expect(languageEnglishName({ language: "spa", region: "MX" })).toBe(
			"Spanish (Mexico)",
		);
		expect(languageQualifierLabels({ language: "spa", region: "MX" })).toEqual([
			"Mexico",
		]);
	});

	it("accepts a language tag anywhere it accepts an identity", () => {
		expect(languageDisplayLabel("spa-MX")).toBe("Español de México");
		expect(languageEnglishName("eng")).toBe("English");
	});

	it("returns undefined outside CLDR's baked coverage instead of a code", () => {
		expect(languageDisplayLabel({ language: "hne" })).toBeUndefined();
		expect(languageEnglishName({ language: "hne" })).toBeUndefined();
	});

	it("orders qualifiers script first, then region", () => {
		expect(
			languageQualifierLabels({
				language: "cmn",
				script: "Hans",
				region: "SG",
			}),
		).toEqual(["Simplified", "Singapore"]);
	});

	it("derives direction from script first, then the language default", () => {
		expect(languageDirection({ language: "arb" })).toBe("rtl");
		expect(languageDirection({ language: "kas", script: "Arab" })).toBe("rtl");
		expect(languageDirection({ language: "kas", script: "Deva" })).toBe("ltr");
		expect(languageDirection({ language: "kas" })).toBe("rtl");
		expect(languageDirection("kas-Deva")).toBe("ltr");
		expect(languageDirection({ language: "eng" })).toBe("ltr");
	});
});

describe("full-catalog name resolution (names.ts)", () => {
	it("is total over the long tail the baked labels omit", () => {
		expect(englishLanguageName("hne")).toBe("Chhattisgarhi");
		expect(resolvedLanguageDisplayLabel({ language: "hne" })).toBe(
			"Chhattisgarhi",
		);
		expect(resolvedLanguageEnglishName({ language: "hne" })).toBe(
			"Chhattisgarhi",
		);
	});

	it("prefers the baked endonym where CLDR knows one", () => {
		expect(resolvedLanguageDisplayLabel({ language: "fra" })).toBe("Français");
	});

	it("composes the qualified English name from registry qualifiers", () => {
		expect(
			resolvedLanguageEnglishName({
				language: "cmn",
				script: "Hans",
				region: "SG",
			}),
		).toBe("Mandarin Chinese (Simplified, Singapore)");
	});

	it("writes the translator-prompt descriptor with axis words", () => {
		expect(
			languageDescriptor({ language: "cmn", script: "Hans", region: "SG" }),
		).toBe("Mandarin Chinese (Simplified script, Singapore conventions)");
		expect(languageDescriptor({ language: "eng" })).toBe("English");
	});

	it("keeps the SIL reference name as a secondary where it differs", () => {
		// hne's common and reference names agree, so no alternate row exists.
		expect(altEnglishLanguageName("hne")).toBeUndefined();
	});
});

describe("macrolanguage helpers and Classic widening", () => {
	it("names a macrolanguage and lists its members", () => {
		expect(macrolanguageName("zho")).toBe("Chinese");
		expect(macrolanguageName("eng")).toBeUndefined();
		expect(macrolanguageMembers("zho")[0]?.code).toBe("cmn");
		expect(macrolanguageMembers("eng")).toEqual([]);
	});

	it("maps a member to its macro for the Classic wire path only", () => {
		expect(classicWideningTarget("cmn")).toBe("zho");
		expect(classicWideningTarget("swh")).toBe("swa");
		expect(classicWideningTarget("eng")).toBeUndefined();
		expect(classicWideningTarget("hne")).toBeUndefined();
	});
});

describe("module boundaries", () => {
	it("keeps the registry out of the lib/domain barrel", () => {
		const barrel = readFileSync(
			path.join(process.cwd(), "lib/domain/index.ts"),
			"utf8",
		);
		expect(barrel).not.toContain("languageRegistry");
	});

	it("lets no test file import the full name catalog directly", () => {
		const testFiles: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name === "node_modules" || entry.name.startsWith(".")) {
					continue;
				}
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.test\.tsx?$/.test(entry.name)) testFiles.push(full);
			}
		};
		for (const root of ["lib", "components", "app", "scripts", "__tests__"]) {
			walk(path.join(process.cwd(), root));
		}
		expect(testFiles.length).toBeGreaterThan(100);
		const offenders = testFiles.filter((file) =>
			/from\s+["'][^"']*names\.catalog["']/.test(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});
