import { describe, expect, it } from "vitest";
import {
	type EffectiveAppLocalization,
	type LanguageTag,
	parseLanguageTag,
} from "@/lib/domain";
import {
	classicWideningTarget,
	languageDirection,
} from "@/lib/domain/languageRegistry";
import { classicLanguageRow } from "../classicLanguages";
import { mintLanguageWireCode, planLanguageWire } from "../languageWire";

const CLASSIC_LOCALE_GRAMMAR = /^[a-z]{2,3}(-[a-z]*)?$/;

/** Each language's code as minted when the languages join in this order. */
function mintedInOrder(
	languageOrder: readonly LanguageTag[],
): Record<LanguageTag, string> {
	const held = new Set<string>();
	const codes: Record<LanguageTag, string> = {};
	for (const tag of languageOrder) {
		const code = mintLanguageWireCode(held, parseLanguageTag(tag));
		held.add(code);
		codes[tag] = code;
	}
	return codes;
}

/** A localization root over `languageOrder` holding the given codes. */
function localization(
	languageOrder: readonly LanguageTag[],
	wireCodes: Record<LanguageTag, string> = mintedInOrder(languageOrder),
): EffectiveAppLocalization {
	const first = languageOrder[0] ?? "eng";
	return {
		sourceLanguage: first,
		defaultLanguage: first,
		languageOrder,
		translations: {},
		wireCodes,
	};
}

describe("mintLanguageWireCode", () => {
	it("spells the four grandfathered languages with their two-letter codes", () => {
		expect(mintedInOrder(["eng", "spa", "swh", "afr"])).toEqual({
			eng: "en",
			spa: "es",
			swh: "sw",
			afr: "af",
		});
	});

	it("widens a macrolanguage member to its Classic row's code", () => {
		// swh has no direct Classic row — it reaches sw through the swa macro.
		expect(classicLanguageRow("swh")).toBeUndefined();
		const swahiliMacro = classicWideningTarget("swh");
		expect(swahiliMacro).toBe("swa");
		expect(classicLanguageRow(swahiliMacro ?? "")?.code).toBe("sw");

		// cmn widens through zho, whose Classic row is not grandfathered.
		const chineseMacro = classicWideningTarget("cmn");
		expect(chineseMacro).toBe("zho");
		expect(classicLanguageRow(chineseMacro ?? "")).toBeDefined();
		expect(
			mintLanguageWireCode(new Set(), { language: "cmn", script: "Hans" }),
		).toBe("zho");
	});

	it("spells a language with no Classic reach by its Set 3 code", () => {
		expect(classicLanguageRow("hne")).toBeUndefined();
		expect(classicWideningTarget("hne")).toBeUndefined();
		expect(mintLanguageWireCode(new Set(["en"]), { language: "hne" })).toBe(
			"hne",
		);
	});

	it("leaves the first language its preferred spelling and suffixes a later one", () => {
		expect(mintedInOrder(["eng", "cmn-Hans", "cmn-Hant"])).toEqual({
			eng: "en",
			"cmn-Hans": "zho",
			"cmn-Hant": "cmn-hant",
		});
		// Which branch keeps the preferred spelling is which joined first.
		expect(mintedInOrder(["eng", "cmn-Hant", "cmn-Hans"])).toEqual({
			eng: "en",
			"cmn-Hant": "zho",
			"cmn-Hans": "cmn-hans",
		});
	});

	it("folds a suffixed identity's script and region into one segment", () => {
		const codes = mintedInOrder(["cmn-Hans-CN", "cmn-Hans-SG", "cmn-Hant-TW"]);
		expect(codes).toEqual({
			"cmn-Hans-CN": "zho",
			"cmn-Hans-SG": "cmn-hanssg",
			"cmn-Hant-TW": "cmn-hanttw",
		});
		for (const code of Object.values(codes)) {
			expect(code).toMatch(CLASSIC_LOCALE_GRAMMAR);
		}
	});

	it("never gives a code the held set names, across a finite language corpus", () => {
		const tagPools: readonly (readonly LanguageTag[])[] = [
			["eng"],
			["eng", "spa", "swh", "afr", "hne"],
			["cmn-Hans", "cmn-Hant"],
			["cmn-Hans-CN", "cmn-Hans-SG", "cmn-Hant-TW", "cmn-Hant-HK"],
			["eng", "cmn-Hans", "cmn-Hant", "swh", "hne"],
			["spa", "spa-MX", "spa-AR"],
			["arb", "urd", "fra", "deu", "por", "zul"],
		];
		for (const languageOrder of tagPools) {
			const codes = Object.values(mintedInOrder(languageOrder));
			expect(codes).toHaveLength(languageOrder.length);
			expect(new Set(codes).size).toBe(codes.length);
			for (const code of codes) expect(code).toMatch(CLASSIC_LOCALE_GRAMMAR);
			for (const tag of languageOrder) {
				expect(["ltr", "rtl"]).toContain(languageDirection(tag));
			}
		}
	});
});

describe("planLanguageWire", () => {
	it("returns the stored codes in languageOrder order", () => {
		const plan = planLanguageWire(
			localization(["spa", "eng", "cmn-Hant"], {
				spa: "es",
				eng: "en",
				"cmn-Hant": "cmn-hant",
			}),
		);
		expect(plan.languages).toEqual(["es", "en", "cmn-hant"]);
		expect(plan.defaultLanguage).toBe("es");
		expect(plan.wireCodeByTag.get("cmn-Hant")).toBe("cmn-hant");
	});

	it("reads a stored code a fresh mint would not give", () => {
		// Traditional Mandarin alone mints zho today; a code stored when the
		// language joined beside Simplified Mandarin stays what it was.
		const plan = planLanguageWire(
			localization(["eng", "cmn-Hant"], { eng: "en", "cmn-Hant": "cmn-hant" }),
		);
		expect(plan.languages).toEqual(["en", "cmn-hant"]);
	});

	it("labels device-picker rows from the baked display labels", () => {
		const plan = planLanguageWire(
			localization(["eng", "cmn-Hans", "cmn-Hant"]),
		);
		expect(plan.nameByWireCode.get("en")).toBe("English");
		const simplified = plan.nameByWireCode.get("zho");
		const traditional = plan.nameByWireCode.get("cmn-hant");
		expect(simplified).toBe("简体中文");
		expect(traditional).toBe("繁體中文");
		// The two Mandarin branches stay distinguishable in the device menu.
		expect(simplified).not.toBe(traditional);
	});

	it("refuses a language with no stored code", () => {
		expect(() =>
			planLanguageWire(localization(["eng", "spa"], { eng: "en" })),
		).toThrow(
			"Language spa has no stored CommCare code. Every app language holds one from the mutation that added it.",
		);
	});
});
