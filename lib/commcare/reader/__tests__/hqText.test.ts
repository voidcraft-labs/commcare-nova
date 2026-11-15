/**
 * The one reading of a CommCare HQ `{language: text}` map. The first cases
 * are HQ's own (`corehq/apps/app_manager/tests/templatetags/test_xforms_extras.py`,
 * `TestTransFilter` and `TestCleanTransFilter`); the rest hold the build's
 * composition (`app_strings.py`'s per-language `non_empty_only` and the
 * `default` merge, under `Localizer.getText`'s fallback) at the shapes a
 * reading meets: the source language missing from the map, a map keyed only
 * by a language the app no longer lists, a blank string, `None`, every
 * language present, and values whose printed text the reader cannot know.
 * The failure each catches is a text read as something HQ's build does not
 * show.
 */
import { describe, expect, it } from "vitest";
import {
	cleanTrans,
	markedTrans,
	shownText,
	sourceAndTranslations,
} from "../hqText";

const text = (t: string) => ({ ok: true, text: t });

describe("HQ's own cases", () => {
	it("trans: an empty map is empty", () => {
		expect(markedTrans({}, [])).toEqual(text(""));
	});
	it("trans: no languages marks the language it took", () => {
		expect(markedTrans({ en: "English Output" }, [])).toEqual(
			text("English Output [en] "),
		);
	});
	it("trans: the first language takes no marker", () => {
		expect(markedTrans({ en: "English Output" }, ["en"])).toEqual(
			text("English Output"),
		);
	});
	it("trans: a later language is marked", () => {
		expect(markedTrans({ en: "English Output" }, ["por", "en"])).toEqual(
			text("English Output [en] "),
		);
	});
	it("trans: markup is kept", () => {
		expect(markedTrans({ en: "<b>English Output</b>" }, [])).toEqual(
			text("<b>English Output</b> [en] "),
		);
	});
	it("clean_trans: the first language", () => {
		expect(cleanTrans({ en: "English Output" }, ["en"])).toEqual(
			text("English Output"),
		);
	});
	it("clean_trans: a later language takes no marker", () => {
		expect(cleanTrans({ por: "Portuguese Output" }, ["en", "por"])).toEqual(
			text("Portuguese Output"),
		);
	});
	it("clean_trans: no languages takes the map's only key", () => {
		expect(cleanTrans({ en: "English Output" }, [])).toEqual(
			text("English Output"),
		);
	});
});

describe("cleanTrans", () => {
	it("holds a blank string as present", () => {
		expect(cleanTrans({ en: "", hin: "H" }, ["en", "hin"])).toEqual(text(""));
	});
	it("passes over None in the requested languages", () => {
		expect(cleanTrans({ en: null, hin: "H" }, ["en", "hin"])).toEqual(
			text("H"),
		);
	});
	it("prints None where the least key holds it", () => {
		expect(cleanTrans({ en: null }, ["en"])).toEqual(text("None"));
	});
	it("prints a boolean as Python does", () => {
		expect(cleanTrans({ en: true }, ["en"])).toEqual(text("True"));
	});
	it("takes the least key by code point, as Python's sort does", () => {
		// UTF-16 order puts the astral key first; Python's puts U+FF5E first.
		expect(cleanTrans({ "\u{1F600}": "astral", "～": "bmp" }, ["en"])).toEqual(
			text("bmp"),
		);
	});
	it("does not know the text of a number, an object or an array", () => {
		expect(cleanTrans({ en: 5 }, ["en"])).toEqual({
			ok: false,
			reason: "value",
			lang: "en",
		});
		expect(cleanTrans({ en: {} }, ["en"])).toEqual({
			ok: false,
			reason: "value",
			lang: "en",
		});
		expect(cleanTrans({ en: [] }, ["en"])).toEqual({
			ok: false,
			reason: "value",
			lang: "en",
		});
	});
	it("reads no map that is not an object", () => {
		for (const stored of [null, undefined, "en", 3, ["en"]])
			expect(cleanTrans(stored, ["en"])).toEqual({
				ok: false,
				reason: "not-a-map",
			});
	});
	it("does not read a key the object only inherits", () => {
		expect(cleanTrans({ hin: "H" }, ["toString", "hin"])).toEqual(text("H"));
	});
});

describe("shownText", () => {
	const langs = ["en", "hin"];

	it("shows a language's own text", () => {
		const map = { en: "E", hin: "H" };
		expect(shownText(map, "en", langs)).toEqual(text("E"));
		expect(shownText(map, "hin", langs)).toEqual(text("H"));
	});
	it("shows the first build language held where a language is missing", () => {
		expect(shownText({ hin: "H" }, "en", langs)).toEqual(text("H"));
		expect(shownText({ en: "E" }, "hin", langs)).toEqual(text("E"));
	});
	it("shows a language the app no longer lists in every language", () => {
		const map = { fra: "F" };
		expect(shownText(map, "en", langs)).toEqual(text("F"));
		expect(shownText(map, "hin", langs)).toEqual(text("F"));
	});
	it("falls back past a blank to the default locale's text", () => {
		// The language's own file drops the blank; the default file holds the first build
		// language's text that is not blank.
		expect(shownText({ en: "", hin: "H" }, "en", langs)).toEqual(text("H"));
		expect(shownText({ en: "E", hin: "" }, "hin", langs)).toEqual(text("E"));
		expect(
			shownText({ en: "", hin: "", fra: "F" }, "hin", ["en", "hin", "fra"]),
		).toEqual(text("F"));
	});
	it("prefers the earlier build language in the default locale", () => {
		expect(
			shownText({ en: "E", hin: "", fra: "F" }, "hin", ["en", "hin", "fra"]),
		).toEqual(text("E"));
	});
	it("reads the default locale as the merge reads each table back", () => {
		// `dumps` writes Spanish's spaces as one non-breaking space, and `loads` strips the line,
		// so Spanish adds "" to the default table, which a text never gives way to: French's
		// "Hola" is the default, and English, whose own text is blank, shows it.
		const order = ["es", "fr", "en"];
		expect(shownText({ es: " ", fr: "Hola", en: "" }, "en", order)).toEqual(
			text("Hola"),
		);
		// A text's spaces at its end are stripped there too; a line break, written `\n`, is not.
		expect(shownText({ es: "Hi  ", en: "" }, "en", ["es", "en"])).toEqual(
			text("Hi"),
		);
		expect(shownText({ es: "Hi\n ", en: "" }, "en", ["es", "en"])).toEqual(
			text("Hi\n"),
		);
		// A language's own text is its own file's, unstripped.
		expect(shownText({ es: "Hi  ", en: "" }, "es", ["es", "en"])).toEqual(
			text("Hi  "),
		);
	});
	it("shows a blank only where every language is blank", () => {
		expect(shownText({ en: "", hin: "" }, "hin", langs)).toEqual(text(""));
		expect(shownText({}, "en", langs)).toEqual(text(""));
	});
	it("names the language whose unknown value would be shown", () => {
		expect(shownText({ en: "E", hin: 2 }, "hin", langs)).toEqual({
			ok: false,
			reason: "value",
			lang: "hin",
		});
		expect(shownText({ en: "E", hin: 2 }, "en", langs)).toEqual(text("E"));
	});
});

describe("sourceAndTranslations", () => {
	const langs = ["en", "hin"];

	it("records every language that shows its own text", () => {
		expect(sourceAndTranslations({ en: "E", hin: "H" }, langs, "en")).toEqual({
			ok: true,
			source: "E",
			translations: { hin: "H" },
		});
		expect(sourceAndTranslations({ en: "E", hin: "H" }, langs, "hin")).toEqual({
			ok: true,
			source: "H",
			translations: { en: "E" },
		});
	});
	it("takes the shown text as the source where the source language is missing", () => {
		expect(sourceAndTranslations({ hin: "H" }, langs, "en")).toEqual({
			ok: true,
			source: "H",
			translations: {},
		});
	});
	it("records no translation for a map keyed only by a language no longer listed", () => {
		expect(sourceAndTranslations({ fra: "F" }, langs, "en")).toEqual({
			ok: true,
			source: "F",
			translations: {},
		});
	});
	it("reads a blank as the text the build shows instead", () => {
		expect(sourceAndTranslations({ en: "", hin: "H" }, langs, "en")).toEqual({
			ok: true,
			source: "H",
			translations: {},
		});
		expect(sourceAndTranslations({ en: "E", hin: "" }, langs, "en")).toEqual({
			ok: true,
			source: "E",
			translations: {},
		});
	});
	it("prints back what HQ's build shows in every language", () => {
		const cases: readonly [Record<string, unknown>, readonly string[]][] = [
			[{ en: "E", hin: "H", fra: "F" }, ["en", "hin", "fra"]],
			[{ en: "", hin: "H", fra: "" }, ["en", "hin", "fra"]],
			[{ en: null, hin: "", fra: "F", xx: "X" }, ["en", "hin", "fra"]],
			[{ zz: "Z", aa: "A" }, ["en", "hin"]],
			[{ en: "E", hin: "H" }, ["hin", "default", "en"]],
		];
		for (const [map, order] of cases)
			for (const source of order.filter((l) => l !== "default")) {
				const read = sourceAndTranslations(map, order, source);
				if (!read.ok) throw new Error("expected a reading");
				for (const lang of order.filter((l) => l !== "default")) {
					const printed =
						lang in read.translations ? read.translations[lang] : read.source;
					// Nova prints a full map: the source where no translation is recorded.
					const novaMap = Object.fromEntries(
						order
							.filter((l) => l !== "default")
							.map((l) => [
								l,
								l in read.translations ? read.translations[l] : read.source,
							]),
					);
					expect(shownText(map, lang, order)).toEqual(text(printed));
					expect(shownText(novaMap, lang, order)).toEqual(text(printed));
				}
			}
	});
	it("says which language holds a value it cannot know", () => {
		expect(sourceAndTranslations({ en: "E", hin: [1] }, langs, "en")).toEqual({
			ok: false,
			reason: "value",
			lang: "hin",
		});
		expect(sourceAndTranslations("E", langs, "en")).toEqual({
			ok: false,
			reason: "not-a-map",
		});
	});
});
