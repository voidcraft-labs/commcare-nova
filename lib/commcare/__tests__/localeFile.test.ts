/**
 * Nova's local archive writes each app string as CommCare HQ's build writes
 * it, so a worker reads one string from either, and the gate admits only a
 * text a device then shows as typed. The writer's contract is
 * `commcare_translations.py::dumps` at the pin (HQ's
 * `submodules/commcare-translations`), read line by line for each row below:
 *
 *     if not val.strip(): val = NBSP               # Python's isspace blank
 *     val = val.replace('\n', '\\n')
 *     val = re.sub(r'(?<!\\)#', r'\#', val)        # lookbehind on the text after the line-break step
 *
 * The plausible failures: a writer that escapes every `#` (Nova's earlier
 * spelling), so a text holding a backslash then `#` shows the backslash on a
 * device from Nova's archive and only `#` from HQ's build, since Core reads
 * `\#` as `#` (`LocalizationUtils.parseValue`); and a gate that admits a text
 * a device shows otherwise than the builder and Preview do (Nova's earlier
 * rule admitted a backslash before `#`).
 */
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, makeTranslationUnitId } from "@/lib/domain";
import { plainColumn } from "@/lib/domain/modules";
import type { ProseTemplate } from "@/lib/domain/prose";
import { casePropertyOptionTranslationUnitId } from "@/lib/domain/translationUnits";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import {
	appStringValueIssue,
	hqLocaleFileValue,
	localeFileValueIssue,
} from "../localeFile";
import { commCareLocalization } from "../localization";
import { targetFactsFromSource } from "../targetFacts";
import { runValidation } from "../validator/runner";
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

describe("hqLocaleFileValue", () => {
	it.each(DUMPS_ROWS)("writes %s as HQ's build does", (_, text, written) => {
		expect(hqLocaleFileValue(text)).toBe(written);
	});
});

/**
 * The string CommCare Core reads for the one line HQ's build writes for
 * `text`, as `LocalizationUtils` reads it at the pin, independent of the
 * reader's own model (`reader/heldText.ts`): the line ended at a carriage
 * return (`BufferedReader.readLine`), trimmed with Java's `String.trim()`, a
 * `#` no backslash precedes and what follows it dropped (`parseAndAdd`), the
 * value after the first `=`, then `\#` read as `#` and `\n` as a line break,
 * left to right (`parseValue`). Undefined where the line defines no string.
 */
function deviceShows(text: string): string | undefined {
	const raw = `key=${hqLocaleFileValue(text)}`.split("\r")[0] ?? "";
	let start = 0;
	let end = raw.length;
	while (start < end && raw.charCodeAt(start) <= 0x20) start += 1;
	while (end > start && raw.charCodeAt(end - 1) <= 0x20) end -= 1;
	let line = raw.slice(start, end);
	let dec = line.length;
	for (;;) {
		const at = line.slice(0, dec).lastIndexOf("#");
		if (at === -1) break;
		if (at === 0 || line[at - 1] !== "\\") {
			line = line.slice(0, at);
			dec = line.length;
		} else dec = at;
	}
	const equal = line.indexOf("=");
	if (equal === -1 || equal === line.length - 1) return undefined;
	return line
		.slice(equal + 1)
		.split("\\#")
		.join("#")
		.split("\\n")
		.join("\n");
}

describe("the gate's rule for an app string, read against a device", () => {
	/** [the sequence, a text holding it, what a device shows of that text]. */
	const SHOWN_OTHERWISE: readonly (readonly [string, string, string])[] = [
		["a backslash followed by n", String.raw`a\nb`, "a\nb"],
		["a backslash followed by #", String.raw`a\#b`, "a#b"],
		["two backslashes followed by #", String.raw`a\\#b`, String.raw`a\#b`],
		["a backslash followed by # at the start", String.raw`\#1`, "#1"],
		["a carriage return", "a\rb", "a"],
		["a space at the end", "a ", "a"],
		["a tab at the end", "a\t", "a"],
	];
	it.each(SHOWN_OTHERWISE)(
		"refuses %s, which a device shows otherwise",
		(_, text, shown) => {
			expect(deviceShows(text)).toBe(shown);
			expect(localeFileValueIssue(text)).toBeDefined();
		},
	);

	// A device keeps these, and Nova holds no text with a space or a line break at either end
	// (the reader drops them, `heldText.ts::holdText`), so the gate refuses them too.
	it.each([
		["a space at the start", " a"],
		["a line break at the start", "\na"],
		["a line break at the end", "a\n"],
	])("refuses %s, which a device keeps", (_, text) => {
		expect(deviceShows(text)).toBe(text);
		expect(localeFileValueIssue(text)).toBeDefined();
	});

	it.each([
		["a # no backslash precedes", "a#b"],
		["a # at the start", "#1"],
		["a line break inside", "a\nb"],
		["a backslash before a line break", "a\\\nb"],
		["a backslash at the end", "a\\"],
		["two backslashes", String.raw`a\\b`],
		["a backslash before another letter", String.raw`a\tb`],
		["an = and an argument marker", `x=\${0}`],
	])("admits %s, which a device shows as typed", (_, text) => {
		expect(localeFileValueIssue(text)).toBeUndefined();
		expect(deviceShows(text)).toBe(text);
	});

	// Every text over the characters Core's reader treats apart, up to four long: the gate admits
	// it only where a device shows it as typed (a blank text shows blank), and every text it
	// refuses but one with a space or a line break at its start or a line break at its end, which
	// a device keeps, a device shows otherwise.
	it("admits only texts a device shows as typed, over every short text of the characters Core reads apart", () => {
		const alphabet = ["a", "n", "#", "\\", "=", " ", "\n", "\r"];
		let texts = [""];
		const all: string[] = [];
		for (let length = 1; length <= 4; length += 1) {
			texts = texts.flatMap((text) => alphabet.map((one) => text + one));
			all.push(...texts);
		}
		for (const text of all) {
			const admitted = localeFileValueIssue(text) === undefined;
			const shown = deviceShows(text);
			if (text.trim() === "") {
				if (admitted) expect(shown, JSON.stringify(text)).toBe("\u00a0");
				continue;
			}
			if (admitted) expect(shown, JSON.stringify(text)).toBe(text);
			else if (text.charCodeAt(0) > 0x20 && !text.endsWith("\n"))
				expect(shown, JSON.stringify(text)).not.toBe(text);
		}
	});
});

/**
 * Core's argument filler at the pin (`Localizer.processArguments(String, String[], int)`,
 * `extractNextIndex`, `replaceFirstValue`, `getArgs`, `clearArguments`), ported line by line
 * and independent of the rule it checks (`localeFile.ts::argumentScreenIssue`). Java's
 * `Integer.parseInt` also reads a sign and non-ASCII digits; an index other than 0 is out of
 * range for one argument, and both branches replace the first `${…}`, so no row turns on it.
 */
function processArguments(
	text: string,
	args: readonly string[],
	currentArg = 0,
): string {
	if (!text.includes("${") || args.length <= currentArg) return text;
	let index = extractNextIndex(text, args);
	let next = currentArg;
	if (index === -1) {
		index = next;
		next += 1;
	}
	const start = text.indexOf("${");
	const end = text.indexOf("}", start);
	// `text.substring(end + 1)`: the whole text where no `}` follows.
	return (
		text.slice(0, start) +
		(args[index] ?? "") +
		processArguments(text.slice(end + 1), args, next)
	);
}

function extractNextIndex(text: string, args: readonly string[]): number {
	const start = text.indexOf("${");
	const end = text.indexOf("}", start);
	if (start === -1 || end === -1) return -1;
	const val = text.slice(start + 2, end);
	if (!/^[+-]?[0-9]+$/.test(val)) return -1;
	const index = Number.parseInt(val, 10);
	return index >= 0 && index < args.length ? index : -1;
}

function clearArguments(text: string): string {
	const args: string[] = [];
	let at = text.indexOf("${");
	while (at !== -1) {
		const end = text.indexOf("}", at);
		if (end === -1) break;
		const arg = text.slice(at + 2, end);
		if (!args.includes(arg)) args.push(arg);
		at = text.indexOf("${", end + 1);
	}
	return processArguments(
		text,
		args.map(() => ""),
	);
}

/** Java's `String.trim()`, which Android and Core apply after filling. */
function javaTrim(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
	while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
	return text.slice(start, end);
}

/** What each screen that fills arguments shows of a text a device's locale file holds:
 *  `MenuAdapter.setupTextView`, `QueryRequestUiController.getLabel` and
 *  `CommCareSession.getHeaderTitles` fill one empty argument, `ViewUtil.addActionToMenu` clears
 *  every named one. */
function argumentScreensShow(text: string): readonly string[] {
	return [
		javaTrim(processArguments(text, [""])),
		javaTrim(clearArguments(text)),
	];
}

describe("the gate's rule for a placeholder opener a screen reads", () => {
	const ARGUMENT_ROLE = "module-name";
	/** [what the row shows, the text, what a screen that fills one empty argument shows]. */
	const SHOWN_OTHERWISE: readonly (readonly [string, string, string])[] = [
		["a numbered placeholder", `Visits \${0}`, "Visits"],
		["a named placeholder", `Visits \${x} today`, "Visits  today"],
		["an empty placeholder", `a\${}b`, "ab"],
		["an opener no } follows, after text", `a\${b`, `aa\${b`],
		["a } before an opener no } follows", `}\${`, `}}\${`],
		["a placeholder opening the text", `\${0} visits`, "visits"],
	];
	it.each(SHOWN_OTHERWISE)(
		"refuses %s in a menu's name, which a screen shows otherwise",
		(_, text, shown) => {
			expect(argumentScreensShow(text)[0]).toBe(shown);
			expect(localeFileValueIssue(text)).toBeUndefined();
			expect(appStringValueIssue(text, ARGUMENT_ROLE)).toBeDefined();
		},
	);

	it.each([
		["an opener that starts the text with no } after it", `\${open`],
		["a $ alone", "Pay $5"],
		["braces alone", "{0} visits"],
		["a $ then a space then {", "$ {0}"],
	])("admits %s, which every screen shows as typed", (_, text) => {
		expect(argumentScreensShow(text)).toEqual([text, text]);
		expect(appStringValueIssue(text, ARGUMENT_ROLE)).toBeUndefined();
	});

	it.each([
		"form-name",
		"case-list-menu-item-label",
		"case-list-registration-label",
		"search-input-label",
	] as const)("refuses a placeholder in a %s too", (role) => {
		expect(appStringValueIssue(`Visits \${0}`, role)).toBeDefined();
	});

	it.each([
		"app-name",
		"case-list-header",
		"search-input-hint",
		"search-screen-title",
		"case-property-option-label",
	] as const)(
		"admits a placeholder in a %s, which no screen reads as one",
		(role) => {
			expect(appStringValueIssue(`Visits \${0}`, role)).toBeUndefined();
		},
	);

	// Every text over the characters the filler and the trim read apart, up to five long: for a
	// role a screen fills, the gate admits it only where every such screen shows it as typed, and
	// every text it refuses that the locale file shows as typed, a screen shows otherwise.
	it("admits only texts every screen shows as typed, over every short text of the characters the filler reads apart", () => {
		const alphabet = ["a", "$", "{", "}", "0", " "];
		let texts = [""];
		const all: string[] = [];
		for (let length = 1; length <= 5; length += 1) {
			texts = texts.flatMap((text) => alphabet.map((one) => text + one));
			all.push(...texts);
		}
		for (const text of all) {
			// A blank text is written as a non-breaking space and shows blank on every screen.
			if (text.trim() === "") continue;
			const shown = argumentScreensShow(text);
			const asTyped = shown.every((one) => one === text);
			if (appStringValueIssue(text, ARGUMENT_ROLE) === undefined)
				expect(asTyped, JSON.stringify(text)).toBe(true);
			else if (localeFileValueIssue(text) === undefined)
				expect(asTyped, JSON.stringify(text)).toBe(false);
		}
	});
});

describe("a local archive's app strings", () => {
	// Nova's own text holds no backslash before `#` (the gate refuses it), and a text the
	// project space holds under its own keys may: each is written as HQ's build writes it.
	it("hold Nova's own # and a project space's backslash before # as HQ's build writes them", () => {
		const doc = localizationWireFixture("escaped");
		const entry =
			doc.localization?.translations.spa?.[
				makeTranslationUnitId("app", "name")
			];
		if (entry === undefined)
			throw new Error("The fixture holds a Spanish app name.");
		entry.value = "Aplicación #1";
		const source = JSON.parse(JSON.stringify(expandDoc(doc))) as {
			translations?: Record<string, Record<string, string>>;
		};
		source.translations = {
			...source.translations,
			es: {
				...source.translations?.es,
				"home.start": String.raw`Empezar \#1 y #2`,
			},
		};
		const facts = targetFactsFromSource(source, {
			observedAt: "2026-11-01T00:00:00.000Z",
			novaOwnsAutoGpsCapture: false,
			adopted: false,
		});
		if (facts === null) throw new Error("The source is an object.");
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
				targetFacts: facts,
			}),
		);
		const lines = zip.readAsText("es/app_strings.txt").split("\n");
		expect(lines).toContain(String.raw`homescreen.title=Aplicación \#1`);
		expect(lines).toContain(String.raw`home.start=Empezar \#1 y \#2`);
	});
});

/**
 * A choice's label of a case property is prose, and a list column over the property writes it
 * into the app strings, its reference chips printed as their hashtags. Every chip's text starts
 * with `#`, so a backslash typed right before a chip is a backslash before `#` in the text the
 * writer prints, which `dumps` leaves and Core drops. The gate reads the same projection the
 * writer prints (`validator/rules/app.ts`, `projectProseTemplate(...).text`), so it refuses the
 * label, and a label with no backslash there is admitted and shows on a device as printed.
 */
describe("a choice's label with a backslash right before a reference chip", () => {
	const docWithLabel = (label: ProseTemplate): BlueprintDoc =>
		buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "stage",
							label: "Stage",
							data_type: "single_select",
							options: [{ value: "a", label }],
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
					caseListConfig: {
						columns: [
							plainColumn(testUuid("name-column"), "case_name", "Name"),
							plainColumn(testUuid("stage-column"), "stage", "Stage"),
						],
						searchInputs: [],
					},
				},
			],
		});
	const chip = {
		kind: "case-ref",
		caseType: "patient",
		property: "case_name",
	} as const;
	const unit = casePropertyOptionTranslationUnitId("patient", "stage", "a");

	it("prints a backslash before `#`, which the gate refuses for the role", () => {
		const doc = docWithLabel({
			parts: [{ kind: "text", text: "Stage \\" }, chip],
		});
		const printed = commCareLocalization(doc).proseTextMap(unit);
		expect(printed).toEqual({ en: "Stage \\#patient/case_name" });
		// What a device shows of the printed text loses the backslash.
		expect(deviceShows(printed.en ?? "")).toBe("Stage #patient/case_name");
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map((one) => [
				one.code,
				(one.details as { role?: string } | undefined)?.role,
			]),
		).toEqual([
			["APP_STRING_VALUE_UNREPRESENTABLE", "case-property-option-label"],
		]);
	});

	it("without the backslash, is admitted and shows on a device as the writer prints it", () => {
		const doc = docWithLabel({
			parts: [{ kind: "text", text: "Stage " }, chip],
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const printed = commCareLocalization(doc).proseTextMap(unit).en ?? "";
		expect(printed).toBe("Stage #patient/case_name");
		const zip = new AdmZip(
			compileCcz(expandDoc(doc), doc.appName, doc, {
				runtimeTarget: TEST_RUNTIME_TARGET,
			}),
		);
		// The choice's label under the column's generated key, in each detail that shows it.
		const values = zip
			.readAsText("en/app_strings.txt")
			.split("\n")
			.filter((one) => one.includes(".enum.knova_text_0="))
			.map((one) => one.slice(one.indexOf("=") + 1));
		expect(values.length).toBeGreaterThan(0);
		for (const value of values)
			expect(value).toBe("Stage \\#patient/case_name");
		expect(deviceShows(printed)).toBe(printed);
	});
});
