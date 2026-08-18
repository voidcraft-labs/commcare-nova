import { describe, expect, it } from "vitest";
import {
	classicWideningTarget,
	languageDirection,
} from "@/lib/domain/languageRegistry";
import { resolvedLanguageDisplayLabel } from "@/lib/domain/languageRegistry/names";
import { classicLanguageRow } from "../classicLanguages";
import { planLanguageWire } from "../languageWire";

const CLASSIC_LOCALE_GRAMMAR = /^[a-z]{2,3}(-[a-z]*)?$/;

describe("planLanguageWire", () => {
	it("spells the four grandfathered languages with their two-letter codes", () => {
		const plan = planLanguageWire(["eng", "spa", "swh", "afr"], "eng");
		expect(plan.languages).toEqual(["en", "es", "sw", "af"]);
		expect(plan.defaultLanguage).toBe("en");
		expect(plan.wireCodeByTag.get("eng")).toBe("en");
		expect(plan.wireCodeByTag.get("spa")).toBe("es");
		expect(plan.wireCodeByTag.get("swh")).toBe("sw");
		expect(plan.wireCodeByTag.get("afr")).toBe("af");
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
		const chineseRow = classicLanguageRow(chineseMacro ?? "");
		expect(chineseRow).toBeDefined();
		const plan = planLanguageWire(["cmn-Hans"], "cmn-Hans");
		expect(plan.wireCodeByTag.get("cmn-Hans")).toBe(chineseRow?.code);
		expect(plan.languages).toEqual([chineseRow?.code]);
	});

	it("emits the Set 3 code itself for a language with no Classic reach", () => {
		expect(classicLanguageRow("hne")).toBeUndefined();
		expect(classicWideningTarget("hne")).toBeUndefined();
		const plan = planLanguageWire(["eng", "hne"], "eng");
		expect(plan.wireCodeByTag.get("hne")).toBe("hne");
	});

	it("suffixes identities that collide on one preferred spelling", () => {
		const plan = planLanguageWire(["eng", "cmn-Hans", "cmn-Hant"], "eng");
		expect(plan.languages).toEqual(["en", "cmn-hans", "cmn-hant"]);
		expect(plan.defaultLanguage).toBe("en");
		expect(plan.wireCodeByTag.get("cmn-Hans")).toBe("cmn-hans");
		expect(plan.wireCodeByTag.get("cmn-Hant")).toBe("cmn-hant");
	});

	it("folds a colliding identity's script and region into one suffix segment", () => {
		const plan = planLanguageWire(
			["cmn-Hans-CN", "cmn-Hans-SG", "cmn-Hant-TW"],
			"cmn-Hans-CN",
		);
		expect(plan.languages).toEqual(["cmn-hanscn", "cmn-hanssg", "cmn-hanttw"]);
		for (const code of plan.languages) {
			expect(code).toMatch(CLASSIC_LOCALE_GRAMMAR);
		}
	});

	it("labels device-picker rows from the baked display labels", () => {
		const plan = planLanguageWire(["eng", "cmn-Hans", "cmn-Hant"], "eng");
		expect(plan.nameByWireCode.get("en")).toBe(
			resolvedLanguageDisplayLabel({ language: "eng" }),
		);
		const simplified = plan.nameByWireCode.get("cmn-hans");
		const traditional = plan.nameByWireCode.get("cmn-hant");
		expect(simplified).toBe(
			resolvedLanguageDisplayLabel({ language: "cmn", script: "Hans" }),
		);
		expect(traditional).toBe(
			resolvedLanguageDisplayLabel({ language: "cmn", script: "Hant" }),
		);
		// The two Mandarin branches stay distinguishable in the device menu.
		expect(simplified).not.toBe(traditional);
	});

	it("is total over the input order and injective across generated tag lists", () => {
		const tagPools: readonly (readonly string[])[] = [
			["eng"],
			["eng", "spa", "swh", "afr", "hne"],
			["cmn-Hans", "cmn-Hant"],
			["cmn-Hans-CN", "cmn-Hans-SG", "cmn-Hant-TW", "cmn-Hant-HK"],
			["eng", "cmn-Hans", "cmn-Hant", "swh", "hne"],
			["spa", "spa-MX", "spa-AR"],
			["arb", "urd", "fra", "deu", "por", "zul"],
		];
		for (const languageOrder of tagPools) {
			const plan = planLanguageWire(languageOrder, languageOrder[0] ?? "eng");
			expect(plan.languages).toHaveLength(languageOrder.length);
			for (const tag of languageOrder) {
				const code = plan.wireCodeByTag.get(tag);
				expect(code).toBeDefined();
				expect(code).toMatch(CLASSIC_LOCALE_GRAMMAR);
				expect(plan.nameByWireCode.has(code ?? "")).toBe(true);
			}
			const codes = [...plan.wireCodeByTag.values()];
			expect(new Set(codes).size).toBe(codes.length);
			// The direction derivation stays total over the same identities so
			// no picker row can exist without a text direction.
			for (const tag of languageOrder) {
				expect(["ltr", "rtl"]).toContain(languageDirection(tag));
			}
		}
	});

	it("refuses to spell a language outside the planned order", () => {
		expect(() => planLanguageWire(["eng"], "fra")).toThrow(
			"The language wire plan has no spelling for fra. Every emitted language must be in the planned languageOrder.",
		);
	});
});
