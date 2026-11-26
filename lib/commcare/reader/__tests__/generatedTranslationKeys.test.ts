/**
 * The generated translation key classifier and its owner rule, over
 * hand-built tables. Contract: a key names a form where its pattern holds
 * `m#f#`, a menu where it holds `m#`, and the app otherwise; repositioning
 * changes only those numbers; a blank value and an id the table lacks are
 * inert; an id a generated wording writes is that wording, whatever its value;
 * a value equal to the table's string is inert; anything else is not yet held,
 * and nothing folds into another text. Plausible failures: an override of a
 * constant called inert, a wording equal to its base dropped, a key read as
 * the wrong owner, a number repositioned that is not the menu's or the form's,
 * a custom assertion read as a menu's.
 */

import { describe, expect, it } from "vitest";
import { makeTranslationUnitId } from "@/lib/domain";
import { GENERATED_APP_STRING_PATTERNS } from "../../appStringKeys";
import {
	classifyGeneratedTranslationKeys,
	generatedKeyOwner,
	type HeldGeneratedKey,
	type MediaKeyReading,
	repositionGeneratedKey,
} from "../generatedTranslationKeys";
import type { AppStringTable } from "../types";

/** A key for a pattern: menu 3, form 5, every `*` a word. */
function keyFor(pattern: string): string {
	return pattern
		.replace("m#f#", "m3f5")
		.replace("m#", "m3")
		.replaceAll("#", "7")
		.replaceAll("*", "word");
}

describe("what a generated key names", () => {
	it.each(GENERATED_APP_STRING_PATTERNS)("reads the owner of %s", (pattern) => {
		const key = keyFor(pattern);
		const owner = generatedKeyOwner(key);
		if (pattern.includes("m#f#"))
			expect(owner).toEqual({ kind: "form", menu: 3, form: 5 });
		else if (pattern.includes("m#"))
			expect(owner).toEqual({ kind: "menu", menu: 3 });
		else expect(owner).toEqual({ kind: "app" });
	});

	it.each(GENERATED_APP_STRING_PATTERNS)(
		"repositions %s at its menu's and form's numbers alone",
		(pattern) => {
			const key = keyFor(pattern);
			const moved = repositionGeneratedKey(key, { menu: 11, form: 0 });
			if (pattern.includes("m#f#"))
				expect(moved).toBe(key.replace("m3f5", "m11f0"));
			else if (pattern.includes("m#"))
				expect(moved).toBe(key.replace("m3", "m11"));
			else expect(moved).toBe(key);
		},
	);

	it("reads a custom assertion's key as the app's whatever it names", () => {
		for (const key of [
			"custom_assertion.m0.f1.3",
			"custom_assertion.m0.3",
			"custom_assertion.root.3",
		]) {
			expect(generatedKeyOwner(key)).toEqual({ kind: "app" });
			expect(repositionGeneratedKey(key, { menu: 4, form: 2 })).toBe(key);
		}
	});
});

const MENU_NAME = makeTranslationUnitId("module", "menu-uuid", "name");
const OPTION_LABEL = makeTranslationUnitId("case-property-option", "x");
const OTHER = makeTranslationUnitId("module", "other", "name");
const HEADER = makeTranslationUnitId("case-list-column", "header");
const HEADER_LABEL = makeTranslationUnitId("case-list-column", "label");

/** A document with two menus: their names, a column header made of two units, and an
 *  option label two lists spell as their own strings. */
const TABLE: AppStringTable = {
	languages: {
		fr: {
			"modules.m0": "Clients",
			"modules.m1": "Autres",
			"m0.case_short.case_name_1.header": "Nom",
			"m0.case_short.case_status_1.enum.k0": "Ouvert",
			"m1.case_short.case_status_1.enum.k0": "Ouvert",
			"cchq.case": "Cas",
			"custom_assertion.root.3": "x",
		},
	},
	units: {
		"modules.m0": MENU_NAME,
		"modules.m1": OTHER,
		"m0.case_short.case_name_1.header": [HEADER, HEADER_LABEL],
		"m0.case_short.case_status_1.enum.k0": OPTION_LABEL,
		"m1.case_short.case_status_1.enum.k0": OPTION_LABEL,
	},
};

const held = (key: string, value: string, id = key): HeldGeneratedKey => ({
	language: "fr",
	key,
	id,
	value,
});

describe("the classifier", () => {
	it("reads a blank override as inert", () => {
		expect(
			classifyGeneratedTranslationKeys([held("modules.m0", "")], TABLE),
		).toEqual([{ kind: "inert" }]);
	});

	it("reads an id the app has no string for as inert", () => {
		expect(
			classifyGeneratedTranslationKeys([held("modules.m9", "Neuf")], TABLE),
		).toEqual([{ kind: "inert" }]);
	});

	it("reads an override equal to the string as inert", () => {
		expect(
			classifyGeneratedTranslationKeys([held("modules.m0", "Clients")], TABLE),
		).toEqual([{ kind: "inert" }]);
	});

	it("reads an override of a string a generated wording writes as that wording, even one equal to the string", () => {
		const MENU_TITLE = makeTranslationUnitId("generated", "menu", "menuTitle");
		const worded: AppStringTable = {
			...TABLE,
			wordingUnits: { "modules.m0": MENU_TITLE },
		};
		expect(
			classifyGeneratedTranslationKeys(
				[held("modules.m0", "Patients"), held("modules.m0", "Clients")],
				worded,
			),
		).toEqual([
			{ kind: "wording", unit: MENU_TITLE, value: "Patients" },
			{ kind: "wording", unit: MENU_TITLE, value: "Clients" },
		]);
	});

	it("folds nothing: an override of a string one unit makes, where no wording writes it, is not yet held", () => {
		expect(
			classifyGeneratedTranslationKeys(
				[
					held("modules.m0", "Patients"),
					held("m0.case_short.case_status_1.enum.k0", "Actif"),
					held("m1.case_short.case_status_1.enum.k0", "Actif"),
				],
				TABLE,
			),
		).toEqual([{ kind: "not-yet" }, { kind: "not-yet" }, { kind: "not-yet" }]);
	});

	it("holds nothing of a unit whose strings hold different overrides", () => {
		expect(
			classifyGeneratedTranslationKeys(
				[held("m0.case_short.case_status_1.enum.k0", "Actif")],
				TABLE,
			),
		).toEqual([{ kind: "not-yet" }]);
	});

	it("holds nothing of a constant's override or of a string several units make", () => {
		expect(
			classifyGeneratedTranslationKeys(
				[
					held("cchq.case", "Dossier"),
					held("m0.case_short.case_name_1.header", "Prénom"),
				],
				TABLE,
			),
		).toEqual([{ kind: "not-yet" }, { kind: "not-yet" }]);
	});

	it("judges a key by the id its menu stands at in the document", () => {
		expect(
			classifyGeneratedTranslationKeys(
				[held("modules.m1", "Clients", "modules.m0")],
				TABLE,
			),
		).toEqual([{ kind: "inert" }]);
	});

	it("reads a custom assertion's key as inert against a table that writes none", () => {
		const table: AppStringTable = {
			languages: { fr: { "modules.m0": "Clients", "modules.m1": "Autres" } },
			units: { "modules.m0": MENU_NAME, "modules.m1": OTHER },
		};
		for (const key of [
			"custom_assertion.m0.f1.3",
			"custom_assertion.m0.3",
			"custom_assertion.root.3",
		])
			expect(
				classifyGeneratedTranslationKeys([held(key, "Vérifiez")], table),
			).toEqual([{ kind: "inert" }]);
	});

	it("judges a key a media map or an image map writes by what CommCare HQ's build reads there, which the table holds none of", () => {
		const icon = held("modules.m0.icon", "jr://file/commcare/image/b.png");
		const alt = held("m0.case_short.case_photo_1.alt_text.kyes", "A photo");
		const verdicts = (reading: MediaKeyReading) =>
			classifyGeneratedTranslationKeys([icon, alt], TABLE, () => reading);
		expect(verdicts({ kind: "unread" })).toEqual([
			{ kind: "inert" },
			{ kind: "inert" },
		]);
		expect(
			verdicts({ kind: "shows", value: "jr://file/commcare/image/b.png" })[0],
		).toEqual({ kind: "inert" });
		expect(
			verdicts({ kind: "shows", value: "jr://file/commcare/image/a.png" })[0],
		).toEqual({ kind: "not-yet" });
		expect(verdicts({ kind: "read" })).toEqual([
			{ kind: "not-yet" },
			{ kind: "inert" },
		]);
		// A blank override is dropped by HQ's build whatever the key reads.
		expect(
			classifyGeneratedTranslationKeys(
				[held("modules.m0.icon", "")],
				TABLE,
				() => ({
					kind: "read",
				}),
			),
		).toEqual([{ kind: "inert" }]);
	});
});
