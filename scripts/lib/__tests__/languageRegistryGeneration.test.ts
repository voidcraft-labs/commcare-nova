import { describe, expect, it } from "vitest";
import {
	deriveLanguageRegistry,
	type LanguageRegistrySource,
	type LocaleNamesFile,
} from "../languageRegistryGeneration";

function tabRow(cells: readonly string[]): string {
	return cells.join("\t");
}

const ISO_6393_TAB = [
	tabRow([
		"Id",
		"Part2b",
		"Part2t",
		"Part1",
		"Scope",
		"Language_Type",
		"Ref_Name",
		"Comment",
	]),
	tabRow(["ara", "", "", "ar", "M", "L", "Arabic", ""]),
	tabRow(["arb", "", "", "", "I", "L", "Standard Arabic", ""]),
	tabRow(["cmn", "", "", "", "I", "L", "Mandarin Chinese", ""]),
	tabRow(["div", "", "", "dv", "I", "L", "Dhivehi", ""]),
	tabRow(["eng", "", "", "en", "I", "L", "English", ""]),
	tabRow(["epo", "", "", "eo", "I", "C", "Esperanto", ""]),
	tabRow(["kas", "", "", "ks", "I", "L", "Kashmiri", ""]),
	tabRow(["lat", "", "", "la", "I", "H", "Latin", ""]),
	tabRow(["mis", "", "", "", "S", "S", "Uncoded languages", ""]),
	tabRow(["pes", "", "", "", "I", "L", "Iranian Persian", ""]),
	tabRow(["prs", "", "", "", "I", "L", "Dari", ""]),
	tabRow(["spa", "", "", "es", "I", "L", "Spanish", ""]),
	tabRow(["yue", "", "", "", "I", "L", "Yue Chinese", ""]),
	tabRow(["zho", "", "", "zh", "M", "L", "Chinese", ""]),
].join("\n");

const MACROLANGUAGES_TAB = [
	tabRow(["M_Id", "I_Id", "I_Status"]),
	tabRow(["ara", "arb", "A"]),
	tabRow(["zho", "cmn", "A"]),
	tabRow(["zho", "lzh", "A"]),
	tabRow(["zho", "yue", "A"]),
	tabRow(["zho", "wuu", "R"]),
].join("\n");

const SCRIPT_METADATA_TXT = [
	"# script metadata fixture",
	"Arab;8;0;x;y;z;YES;more",
	"Deva;2;0;x;y;z;NO;more",
	"Hans;3;0;x;y;z;NO;more",
	"Hant;4;0;x;y;z;NO;more",
	"Latn;1;0;x;y;z;NO;more",
].join("\n");

const LOCALE_FILES: Record<string, LocaleNamesFile> = {
	en: {
		languages: {
			ar: "Arabic",
			dv: "Divehi",
			en: "English",
			es: "Spanish",
			fa: "Persian",
			"fa-AF": "Dari",
			ks: "Kashmiri",
			yue: "Cantonese",
			zh: "Chinese",
			"zh-Hans": "Simplified Chinese",
			"zh-Hant": "Traditional Chinese",
		},
		scripts: {
			Arab: "Arabic",
			Deva: "Devanagari",
			Hans: "Simplified",
			Hant: "Traditional",
			Latn: "Latin",
		},
		territories: {
			AF: "Afghanistan",
			AR: "Argentina",
			CN: "China",
			EG: "Egypt",
			ES: "Spain",
			GB: "United Kingdom",
			HK: "Hong Kong SAR China",
			IN: "India",
			IR: "Iran",
			MO: "Macao SAR China",
			MX: "Mexico",
			SG: "Singapore",
			TJ: "Tajikistan",
			TW: "Taiwan",
			US: "United States",
		},
	},
	es: {
		languages: { es: "español", "es-MX": "español de México" },
		territories: { AR: "Argentina", ES: "España", MX: "México" },
	},
	zh: {
		languages: { zh: "中文", "zh-Hans": "简体中文", "zh-Hant": "繁體中文" },
		territories: { CN: "中国", SG: "新加坡" },
	},
	fa: { languages: { fa: "فارسی" } },
	ks: { languages: { ks: "کٲشُر" } },
};

function officialRows(entries: Record<string, string | undefined>): {
	languagePopulation: Record<string, { _officialStatus?: string }>;
} {
	return {
		languagePopulation: Object.fromEntries(
			Object.entries(entries).map(([key, status]) => [
				key,
				status === undefined ? {} : { _officialStatus: status },
			]),
		),
	};
}

const SOURCE: LanguageRegistrySource = {
	iso6393Tab: ISO_6393_TAB,
	macrolanguagesTab: MACROLANGUAGES_TAB,
	languageAliases: {
		arb: { _reason: "macrolanguage", _replacement: "ar" },
		cmn: { _reason: "macrolanguage", _replacement: "zh" },
		div: { _reason: "overlong", _replacement: "dv" },
		eng: { _reason: "overlong", _replacement: "en" },
		epo: { _reason: "overlong", _replacement: "eo" },
		kas: { _reason: "overlong", _replacement: "ks" },
		lat: { _reason: "overlong", _replacement: "la" },
		pes: { _reason: "overlong", _replacement: "fa" },
		prs: { _replacement: "fa-AF" },
		spa: { _reason: "overlong", _replacement: "es" },
		zho: { _reason: "overlong", _replacement: "zh" },
	},
	languageData: {
		ar: { _scripts: ["Arab"] },
		en: { _scripts: ["Latn"] },
		es: { _scripts: ["Latn"] },
		fa: { _scripts: ["Arab"] },
		ks: { _scripts: ["Arab", "Deva"] },
		zh: { _scripts: ["Hans"] },
	},
	territoryInfo: {
		AF: officialRows({ fa: "official" }),
		AR: officialRows({ es: "official" }),
		CN: officialRows({ zh: "official" }),
		EG: officialRows({ ar: "official" }),
		ES: officialRows({ es: "official" }),
		GB: officialRows({ en: "official" }),
		HK: officialRows({ "zh-Hant": "official" }),
		IN: officialRows({ ks: "official" }),
		IR: officialRows({ fa: "official" }),
		MO: officialRows({ "zh-Hant": "official" }),
		MX: officialRows({ es: "de_facto_official" }),
		SG: officialRows({ zh: "official" }),
		TJ: officialRows({ fa: "official" }),
		TW: officialRows({ "zh-Hant": "official" }),
		US: officialRows({ en: "de_facto_official", es: undefined }),
	},
	likelySubtags: {
		ar: "ar-Arab-EG",
		en: "en-Latn-US",
		es: "es-Latn-ES",
		fa: "fa-Arab-IR",
		ks: "ks-Arab-IN",
		yue: "yue-Hant-HK",
		zh: "zh-Hans-CN",
		"zh-Hans": "zh-Hans-CN",
		"zh-Hant": "zh-Hant-TW",
		"zh-SG": "zh-Hans-SG",
	},
	scriptMetadataTxt: SCRIPT_METADATA_TXT,
	availableLocaleDirs: ["en", "es", "zh", "fa", "ks"],
	localeNames: (locale) => LOCALE_FILES[locale],
};

const registry = deriveLanguageRegistry(SOURCE);

describe("deriveLanguageRegistry", () => {
	it("packs sorted living-individual codes and classifies the rest by type", () => {
		expect(registry.livingIndividualCodesPacked).toBe(
			"arbcmndivengkaspesprsspayue",
		);
		expect(registry.nonLivingCodesPacked).toBe("epoClatHmisS");
	});

	it("maps ISO 639-1 codes onto their Set 3 rows, macros included", () => {
		expect(registry.iso6391ToSet3.en).toBe("eng");
		expect(registry.iso6391ToSet3.zh).toBe("zho");
		expect(registry.iso6391ToSet3.ks).toBe("kas");
		expect(registry.iso6391ToSet3.la).toBe("lat");
	});

	it("lists macrolanguage members alive-only, predominant member first", () => {
		expect(registry.macrolanguages.map((entry) => entry.code)).toEqual([
			"ara",
			"zho",
		]);
		const zho = registry.macrolanguages[1];
		expect(zho?.name).toBe("Chinese");
		// lzh is not a living row and wuu's membership status is retired, so
		// only cmn and yue survive; CLDR canonicalizes cmn onto zh, which is
		// what puts it ahead of yue.
		expect(zho?.members).toEqual([
			{ code: "cmn", name: "Mandarin Chinese" },
			{ code: "yue", name: "Cantonese" },
		]);
		expect(registry.macrolanguageOfMember).toEqual({
			arb: "ara",
			cmn: "zho",
			yue: "zho",
		});
	});

	it("keeps a macro-aliased member's own name instead of the group headword", () => {
		expect(registry.commonEnglishNameByCode.cmn).toBe("Mandarin Chinese");
		expect(registry.englishNamesPacked).toContain("cmnMandarin Chinese");
	});

	it("derives multi-script branches with composed labels and fallbacks", () => {
		expect(registry.multiScriptLanguages).toEqual([
			{
				language: "cmn",
				scripts: [
					{
						script: "Hans",
						label: "Simplified Chinese",
						qualifier: "Simplified",
						direction: "ltr",
					},
					{
						script: "Hant",
						label: "Traditional Chinese",
						qualifier: "Traditional",
						direction: "ltr",
					},
				],
			},
			{
				language: "kas",
				scripts: [
					{
						script: "Arab",
						label: "Kashmiri (Arabic script)",
						qualifier: "Arabic",
						direction: "rtl",
					},
					{
						script: "Deva",
						label: "Kashmiri (Devanagari script)",
						qualifier: "Devanagari",
						direction: "ltr",
					},
				],
			},
		]);
	});

	it("keys region choices by script and orders the likely region first", () => {
		expect(registry.regionChoices).toEqual([
			{
				language: "cmn",
				script: "Hans",
				regions: [
					{ region: "CN", label: "China" },
					{ region: "SG", label: "Singapore" },
				],
			},
			{
				language: "cmn",
				script: "Hant",
				regions: [
					{ region: "TW", label: "Taiwan" },
					{ region: "HK", label: "Hong Kong SAR China" },
					{ region: "MO", label: "Macao SAR China" },
				],
			},
			{
				language: "eng",
				regions: [
					{ region: "US", label: "United States" },
					{ region: "GB", label: "United Kingdom" },
				],
			},
			{
				language: "pes",
				regions: [
					{ region: "IR", label: "Iran" },
					{ region: "TJ", label: "Tajikistan" },
				],
			},
			{
				language: "spa",
				regions: [
					{ region: "ES", label: "Spain" },
					{ region: "AR", label: "Argentina" },
					{ region: "MX", label: "Mexico" },
				],
			},
		]);
	});

	it("lets a region-bearing alias claim its territory from siblings", () => {
		// prs canonicalizes to fa-AF, so Afghanistan belongs to Dari and the
		// region-free Persian sibling offers only the unclaimed territories.
		const pes = registry.regionChoices.find(
			(entry) => entry.language === "pes",
		);
		expect(pes?.regions.map((choice) => choice.region)).not.toContain("AF");
	});

	it("requires an official status before a territory counts", () => {
		const spa = registry.regionChoices.find(
			(entry) => entry.language === "spa",
		);
		// The US row carries a Spanish population with no official status.
		expect(spa?.regions.map((choice) => choice.region)).not.toContain("US");
	});

	it("bakes capitalized endonyms at the most specific CLDR key", () => {
		expect(registry.endonymByKey.spa).toBe("Español");
		expect(registry.endonymByKey["spa-MX"]).toBe("Español de México");
		expect(registry.endonymByKey["spa-ES"]).toBe("Español (España)");
		expect(registry.endonymByKey.cmn).toBe("中文");
		expect(registry.endonymByKey["cmn-Hans"]).toBe("简体中文");
		expect(registry.endonymByKey["cmn-Hant"]).toBe("繁體中文");
		expect(registry.endonymByKey["cmn-Hans-CN"]).toBe("简体中文 (中国)");
		// yue has no locale directory, so it bakes no endonym while its
		// English name still reaches the full-catalog names file.
		expect(registry.endonymByKey.yue).toBeUndefined();
		expect(registry.commonEnglishNameByCode.yue).toBeUndefined();
		expect(registry.englishNamesPacked).toContain("yueCantonese");
	});

	it("collects RTL scripts and the languages whose default script is RTL", () => {
		expect(registry.rtlScripts).toEqual(["Arab"]);
		expect(registry.rtlDefaultLanguageCodesPacked).toBe("arbkaspesprs");
	});

	it("routes a region-aliased language's English name through its exact key", () => {
		expect(registry.englishNamesPacked).toContain("prsDari");
	});

	it("keeps the SIL reference name only where the display name differs", () => {
		expect(registry.altEnglishNamesPacked).toBe(
			["divDhivehi", "pesIranian Persian", "yueYue Chinese"].join("\n"),
		);
	});

	it("refuses a source file whose layout changed", () => {
		expect(() =>
			deriveLanguageRegistry({ ...SOURCE, iso6393Tab: "bogus" }),
		).toThrow(/SIL may have changed the file layout/);
		expect(() =>
			deriveLanguageRegistry({
				...SOURCE,
				iso6393Tab: `${ISO_6393_TAB}\nabc\tonly`,
			}),
		).toThrow(/missing its Id\/Scope\/Language_Type\/Ref_Name cells/);
	});
});
