import { describe, expect, it } from "vitest";
import {
	chooseLanguage,
	chooseRegion,
	chooseScript,
	duplicateLanguageRefusal,
	EMPTY_LANGUAGE_CHOICE,
	hiddenMatchesLine,
	LANGUAGE_ROW_LIMIT,
	pickerRowForCode,
	regionalConventionOptions,
	resolvedLanguageSelection,
	searchLanguageRows,
	selectionPreview,
	writingSystemOptions,
} from "@/components/builder/app-setup/languagePicker/pickerModel";
// The dialogs reach this module only through the lazy loader; the test
// imports it directly because it IS the fixture the model runs over.
import * as registrySearch from "@/lib/domain/languageRegistry/search";

const data = registrySearch;

describe("searchLanguageRows", () => {
	it("returns the full alphabetical catalog for an empty query", () => {
		const view = searchLanguageRows(data, "");
		expect(view.rows.length).toBeGreaterThan(6000);
		expect(view.hiddenMatchCount).toBe(0);
		expect(view.notice).toBeUndefined();
	});

	it("ranks an exact name match first with endonym and English labels", () => {
		const view = searchLanguageRows(data, "french");
		expect(view.rows[0]).toEqual({
			code: "fra",
			primaryLabel: "Français",
			secondaryLabel: "French",
		});
		expect(view.hiddenMatchCount).toBe(0);
	});

	it("resolves a typed Set 3 code as the first row", () => {
		const view = searchLanguageRows(data, "cmn");
		expect(view.rows[0]?.code).toBe("cmn");
		expect(view.rows[0]?.primaryLabel).toBe("中文");
		expect(view.notice).toBeUndefined();
	});

	it("caps a broad query at the row limit with a hidden count", () => {
		const view = searchLanguageRows(data, "a");
		expect(view.rows).toHaveLength(LANGUAGE_ROW_LIMIT);
		expect(view.hiddenMatchCount).toBeGreaterThan(0);
		expect(hiddenMatchesLine(view.hiddenMatchCount)).toBe(
			`${view.hiddenMatchCount} more languages match. Keep typing to narrow the list`,
		);
	});

	it("renders no keep-typing line when every match shows", () => {
		expect(hiddenMatchesLine(0)).toBeUndefined();
		expect(hiddenMatchesLine(1)).toBe(
			"1 more language matches. Keep typing to narrow the list",
		);
	});

	it("turns a macrolanguage query into a code-free notice with member rows", () => {
		const view = searchLanguageRows(data, "zho");
		expect(view.notice?.message).toBe(
			"Chinese is a group of languages, not one language. Choose the one workers speak:",
		);
		expect(view.notice?.rows[0]).toEqual({
			code: "cmn",
			primaryLabel: "中文",
			secondaryLabel: "Mandarin Chinese",
		});
	});

	it("resolves a two-letter shorthand and drops its target from the rows", () => {
		const view = searchLanguageRows(data, "en");
		expect(view.notice?.message).toBe(
			"That's the two-letter shorthand for English. Choose the language itself:",
		);
		expect(view.notice?.rows).toEqual([
			{ code: "eng", primaryLabel: "English" },
		]);
		expect(view.rows.some((row) => row.code === "eng")).toBe(false);
	});

	it("explains a non-living code with no rows to offer", () => {
		const view = searchLanguageRows(data, "lat");
		expect(view.notice?.message).toBe(
			"That names a historical language, and app languages are living languages workers speak today",
		);
		expect(view.notice?.rows).toEqual([]);
	});

	it("treats an unknown token as an ordinary query with no notice", () => {
		const view = searchLanguageRows(data, "xxx");
		expect(view.notice).toBeUndefined();
	});
});

describe("the language, writing system, region cascade", () => {
	it("resets script and region when the language changes", () => {
		const before = { language: "cmn", script: "Hans", region: "CN" };
		expect(chooseLanguage(before, "spa")).toEqual({ language: "spa" });
		expect(chooseLanguage(before, "cmn")).toBe(before);
	});

	it("resets region when the script changes and ignores a script with no language", () => {
		const before = { language: "cmn", script: "Hans", region: "CN" };
		expect(chooseScript(before, "Hant")).toEqual({
			language: "cmn",
			script: "Hant",
		});
		expect(chooseScript(EMPTY_LANGUAGE_CHOICE, "Hans")).toBe(
			EMPTY_LANGUAGE_CHOICE,
		);
	});

	it("maps the general-conventions choice to an absent region", () => {
		const withRegion = chooseRegion({ language: "spa" }, "MX");
		expect(withRegion).toEqual({ language: "spa", region: "MX" });
		expect(chooseRegion(withRegion, undefined)).toEqual({ language: "spa" });
	});

	it("resolves a non-branching language immediately", () => {
		expect(resolvedLanguageSelection({ language: "spa" })).toEqual({
			identity: { language: "spa" },
			tag: "spa",
		});
	});

	it("resolves nothing while a branching language has no script chosen", () => {
		expect(resolvedLanguageSelection({ language: "cmn" })).toBeUndefined();
		expect(
			resolvedLanguageSelection({ language: "cmn", script: "Hans" }),
		).toEqual({
			identity: { language: "cmn", script: "Hans" },
			tag: "cmn-Hans",
		});
	});

	it("ignores a stale script or region instead of resolving an unlawful identity", () => {
		expect(
			resolvedLanguageSelection({ language: "spa", script: "Hans" }),
		).toEqual({ identity: { language: "spa" }, tag: "spa" });
		expect(
			resolvedLanguageSelection({
				language: "cmn",
				script: "Hans",
				region: "TW",
			}),
		).toEqual({
			identity: { language: "cmn", script: "Hans" },
			tag: "cmn-Hans",
		});
	});

	it("resolves a chosen region", () => {
		expect(
			resolvedLanguageSelection({ language: "spa", region: "MX" }),
		).toEqual({ identity: { language: "spa", region: "MX" }, tag: "spa-MX" });
	});
});

describe("writingSystemOptions", () => {
	it("offers each writing system with its composed label", () => {
		const options = writingSystemOptions("kas", []);
		expect(options).toEqual([
			{ script: "Arab", label: "Kashmiri (Arabic script)" },
			{ script: "Deva", label: "Kashmiri (Devanagari script)" },
		]);
	});

	it("disables a writing system whose every identity already exists", () => {
		const options = writingSystemOptions("cmn", [
			"cmn-Hans",
			"cmn-Hans-CN",
			"cmn-Hans-SG",
		]);
		const hans = options.find((option) => option.script === "Hans");
		const hant = options.find((option) => option.script === "Hant");
		expect(hans?.disabledReason).toBe("Already in this app");
		expect(hant?.disabledReason).toBeUndefined();
	});
});

describe("regionalConventionOptions", () => {
	it("puts the general choice first, then the named regions", () => {
		const options = regionalConventionOptions(data, "cmn", "Hans");
		expect(options[0]).toEqual({
			label: "General Mandarin Chinese",
			description: "Not tailored to one country's conventions",
		});
		expect(options.slice(1)).toEqual([
			{ region: "CN", label: "China" },
			{ region: "SG", label: "Singapore" },
		]);
	});

	it("offers nothing where the language has no regional conventions", () => {
		expect(regionalConventionOptions(data, "zul", undefined)).toEqual([]);
	});
});

describe("duplicate refusal and preview", () => {
	it("refuses a resolved identity the app already has, by name", () => {
		const selection = {
			identity: { language: "spa", region: "MX" },
			tag: "spa-MX",
		};
		expect(duplicateLanguageRefusal(data, selection, ["spa", "spa-MX"])).toBe(
			"Spanish (Mexico) is already one of this app's languages",
		);
		expect(duplicateLanguageRefusal(data, selection, ["spa"])).toBeUndefined();
	});

	it("previews the resolved language with its direction in words", () => {
		expect(selectionPreview(data, { language: "spa" })).toEqual({
			label: "Español",
			direction: "ltr",
			directionWord: "left to right",
		});
		expect(selectionPreview(data, { language: "arb" })).toEqual({
			label: "العربية",
			direction: "rtl",
			directionWord: "right to left",
		});
		expect(selectionPreview(data, { language: "cmn", script: "Hans" })).toEqual(
			{
				label: "简体中文",
				direction: "ltr",
				directionWord: "left to right",
			},
		);
	});

	it("resolves a known code to its picker row", () => {
		expect(pickerRowForCode(data, "hne")).toEqual({
			code: "hne",
			primaryLabel: "Chhattisgarhi",
		});
	});
});
