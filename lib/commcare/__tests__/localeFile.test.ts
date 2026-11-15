/**
 * Nova's local archive writes each app string as CommCare HQ's build writes
 * it, so a worker reads one string from either. The contract is
 * `commcare_translations.py::dumps` at the pin (HQ's
 * `submodules/commcare-translations`), read line by line for each row below:
 *
 *     if not val.strip(): val = NBSP               # Python's isspace blank
 *     val = val.replace('\n', '\\n')
 *     val = re.sub(r'(?<!\\)#', r'\#', val)        # lookbehind on the text after the line-break step
 *
 * The plausible failure is a writer that escapes every `#` (Nova's earlier
 * spelling): a text holding a backslash then `#` then shows the backslash on
 * a device from Nova's archive and only `#` from HQ's build, since Core reads
 * `\#` as `#` (`LocalizationUtils.parseValue`).
 */
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { makeTranslationUnitId } from "@/lib/domain";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import { serializeLocaleFileValue } from "../localeFile";
import { localizationWireFixture } from "./localizationWireFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

/** The characters a row names by code point, so the source holds none invisible. */
const NBSP = String.fromCharCode(0xa0);
const NEL = String.fromCharCode(0x85);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const BOM = String.fromCharCode(0xfeff);

/** [what the row shows, the text, the value `dumps` writes for it]. */
const DUMPS_ROWS: readonly (readonly [string, string, string])[] = [
	["a lone #", "#", String.raw`\#`],
	["a # inside a text", "a#b", String.raw`a\#b`],
	["a # at the line's start", "#start", String.raw`\#start`],
	[
		"a # a backslash precedes, left as it is",
		String.raw`a\#b`,
		String.raw`a\#b`,
	],
	["a backslash then # alone", String.raw`\#`, String.raw`\#`],
	["two backslashes then #", String.raw`a\\#b`, String.raw`a\\#b`],
	["two # side by side, each escaped", "##", String.raw`\#\#`],
	["an escaped # then a bare one", String.raw`\##`, String.raw`\#\#`],
	["a bare # then an escaped one", String.raw`#\#`, String.raw`\#\#`],
	[
		"a # after a line break, which `dumps` writes as `\\n`",
		"a\n#b",
		String.raw`a\n\#b`,
	],
	["a backslash before a line break", "a\\\nb", String.raw`a\\nb`],
	[
		"a backslash before the letter n with a space between",
		String.raw`a\ n`,
		String.raw`a\ n`,
	],
	["a trailing backslash", "a\\", "a\\"],
	["an = in the value", "x=y", "x=y"],
	["non-ASCII text", "Aplicación ✓ 日本語", "Aplicación ✓ 日本語"],
	["an empty text", "", NBSP],
	["a non-breaking space alone, which Python reads as blank", NBSP, NBSP],
	[
		"U+0085 alone, which Python reads as blank and JavaScript's trim does not",
		NEL,
		NBSP,
	],
	["U+3000 alone, which Python reads as blank", IDEOGRAPHIC_SPACE, NBSP],
	["U+FEFF alone, which JavaScript's trim drops and Python keeps", BOM, BOM],
];

describe("serializeLocaleFileValue", () => {
	it.each(DUMPS_ROWS)("writes %s as HQ's build does", (_, text, written) => {
		expect(serializeLocaleFileValue("key", text)).toBe(written);
	});

	it.each([
		["the two characters \\n", String.raw`a\nb`],
		["a carriage return", "a\rb"],
		["a space at the start", " a"],
		["a line break at the end", "a\n"],
	])(
		"refuses a text holding %s, which Nova's gate admits no spelling of",
		(_, text) => {
			expect(() => serializeLocaleFileValue("key", text)).toThrow(
				/App string "key"/,
			);
		},
	);
});

describe("a local archive's app strings", () => {
	it("hold a backslash before # as HQ's build writes it", () => {
		const doc = localizationWireFixture("escaped");
		const entry =
			doc.localization?.translations.spa?.[
				makeTranslationUnitId("app", "name")
			];
		if (entry === undefined)
			throw new Error("The fixture holds a Spanish app name.");
		entry.value = String.raw`Aplicación \#1 y #2`;
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		const line = zip
			.readAsText("es/app_strings.txt")
			.split("\n")
			.find((one) => one.startsWith("homescreen.title="));
		expect(line).toBe(String.raw`homescreen.title=Aplicación \#1 y \#2`);
	});
});
