/**
 * Generated translation keys in a whole reading.
 *
 * Contract: every generated key is decided in the reading that meets it. A
 * key whose menu read whole is classified, against the string of the
 * position its menu stands at in the document, even beside another menu's
 * finding; a key whose menu holds a finding, or whose language the reading
 * could not name, stands under that finding and is reported neither again nor
 * as `unrecognized`; with no table beside a finding every key stands under
 * the first finding; with no table and no finding the reader throws; a
 * key that names a string the app does not make is inert; a finding at a
 * menu's case list covers the menu's keys and no key of a form position the
 * menu holds none at; a choice's label that two menus' lists show, one of them
 * a mirror, is judged at the menu that read whole and stands under the
 * mirror's finding at the other, and a split list header after a menu with
 * a finding stays with the menu whose worker sees it.
 *
 * Plausible failures: a key judged against the menu that now stands at its
 * number, a covered key reported, a key left unclaimed where there is no
 * table, a clean reading whose document the gate refuses returned.
 */

import { describe, expect, it } from "vitest";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { localAppStringTable } from "@/lib/commcare/appStrings";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import { generatedWordingId } from "@/lib/domain/generatedWording";
import { plainColumn } from "@/lib/domain/modules";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import { readHqApp } from "../index";
import type { AppStringTable, ReaderInput } from "../types";
import { exportedBody, inputFor, mirrorMenu } from "./novaExport";
import { retainedSourceBody } from "./readerInput";

const GENERATED = "translations-generated-";

function menu(uniqueId: string, extra: Record<string, unknown> = {}) {
	return {
		doc_type: "Module",
		unique_id: uniqueId,
		name: { en: "Clients" },
		case_type: null,
		forms: [],
		...extra,
	};
}

function body(
	modules: readonly Record<string, unknown>[],
	translations: Record<string, Record<string, unknown>>,
	langs: readonly string[] = ["en"],
): Record<string, unknown> {
	return {
		...retainedSourceBody("shell/app-source"),
		langs,
		modules,
		translations: { en: { en: "English" }, ...translations },
	};
}

/** The strings Nova's build gives a document: each menu's name, under its unit, which the menu's
 *  title words. */
function menuStrings(doc: BlueprintDoc): AppStringTable {
	const languages: Record<string, string> = {};
	const units: Record<string, ReturnType<typeof makeTranslationUnitId>> = {};
	const wordingUnits: Record<
		string,
		ReturnType<typeof makeTranslationUnitId>
	> = {};
	doc.moduleOrder.forEach((uuid: Uuid, index) => {
		languages[`modules.m${index}`] = doc.modules[uuid]?.name ?? "";
		units[`modules.m${index}`] = makeTranslationUnitId("module", uuid, "name");
		wordingUnits[`modules.m${index}`] = generatedWordingId(uuid, "menuTitle");
	});
	return { languages: { en: languages }, units, wordingUnits };
}

async function read(
	source: Record<string, unknown>,
	appStrings: ReaderInput["appStrings"] = menuStrings,
) {
	const outcome = readHqApp(await inputFor(source, { appStrings }), {
		claims: "full",
	});
	return {
		outcome,
		generated: [...outcome.claims.records()]
			.filter((record) => record.entry.includes(GENERATED))
			.map((record) => record.entry.slice(record.entry.indexOf("/") + 1)),
		named: (outcome.kind === "account" ? outcome.findings : [])
			.map((finding) => finding.detail.name ?? "")
			.filter(
				(name) => name.includes("translations") || name.includes("modules.m"),
			),
	};
}

describe("a generated key in a reading", () => {
	it("is judged by the position its menu holds in the document, beside a mirror menu's finding", async () => {
		const { outcome, generated, named } = await read(
			body([mirrorMenu("menu-one"), menu("menu-one")], {
				en: { en: "English", "modules.m1": "Patients" },
			}),
		);
		expect(outcome.kind).toBe("account");
		expect(generated).toEqual(["translations-generated-wording"]);
		expect(named).toEqual([]);
	});

	it("stands under the finding at its menu", async () => {
		const { generated, named } = await read(
			body([menu("menu-one", { not_a_module_key: 1 })], {
				en: { en: "English", "modules.m0": "Patients" },
			}),
		);
		expect(generated).toEqual([]);
		expect(named).toEqual([]);
	});

	it("stands under the finding at its menu's case list, and a form position the menu holds none at is classified", async () => {
		const address = "menus-and-case-lists/8-address";
		const source = exportedBody(
			patients([
				plainColumn(uuid(1), "case_name", "Name"),
				plainColumn(uuid(2), "notes", "Notes"),
			]),
			{
				modules: (modules) => {
					const details = modules[0]?.case_details as
						| { short: { columns: Record<string, unknown>[] } }
						| undefined;
					Object.assign(details?.short.columns[1] ?? {}, {
						format: "address",
					});
					return modules;
				},
				root: {
					translations: {
						en: {
							en: "English",
							"modules.m0": "Clients",
							"forms.m0f9": "Nine",
						},
					},
				},
			},
		);
		const { outcome, generated } = await read(source);
		if (outcome.kind !== "account")
			throw new Error("The address column is a finding.");
		const atList = outcome.findings.filter((one) => one.code === address);
		expect(atList.map((one) => one.place.kind)).toEqual(["case-list"]);
		expect(generated).toEqual(["translations-generated-key-with-no-effect"]);
		/* One generated key read, recorded at `translations`, where the key its claim names sits. */
		const keys = [...outcome.claims.records()]
			.filter((record) => record.entry.includes(GENERATED))
			.map((record) => record.where);
		expect(keys).toEqual(["/translations"]);
		expect(
			outcome.findings.filter(
				(one) =>
					one.detail.name === "modules.m0" || one.detail.name === "forms.m0f9",
			),
		).toEqual([]);
	});

	it("stands under the finding at an invalid language code", async () => {
		const { outcome, generated, named } = await read(
			body([menu("menu-one")], { "x x": { "modules.m0": "Patients" } }, [
				"en",
				"x x",
			]),
		);
		expect(outcome.kind).toBe("account");
		expect(generated).toEqual([]);
		expect(named).toEqual([]);
	});

	it("stands under the first finding where there is no table beside one", async () => {
		const { generated, named } = await read(
			body([mirrorMenu("menu-one"), menu("menu-one")], {
				en: { en: "English", "modules.m1": "Patients" },
			}),
			() => null,
		);
		expect(generated).toEqual([]);
		expect(named).toEqual([]);
	});

	it("throws where a reading with no finding gets no table", async () => {
		const input = await inputFor(
			body([menu("menu-one")], {
				en: { en: "English", "modules.m0": "Patients" },
			}),
			{ appStrings: () => null },
		);
		expect(() => readHqApp(input)).toThrow(/Nova's gate refuses/);
	});

	it("is inert where it names a string the app does not make", async () => {
		const { generated, named } = await read(
			body([menu("menu-one")], {
				en: { en: "English", "modules.m7": "Seven" },
			}),
		);
		expect(generated).toEqual(["translations-generated-key-with-no-effect"]);
		expect(named).toEqual([]);
	});

	it("is judged at the menu that read whole where a choice's label shows in two lists, one a mirror's", async () => {
		const enumKey = (menu: number) =>
			`m${menu}.case_short.case_status_1.enum.ka`;
		const { outcome, generated, named } = await read(
			body([mirrorMenu("menu-one"), menu("menu-one")], {
				en: { en: "English", [enumKey(0)]: "Active", [enumKey(1)]: "Active" },
			}),
			(doc) => {
				const strings = menuStrings(doc);
				return {
					...strings,
					languages: {
						en: { ...strings.languages.en, [enumKey(0)]: "Active" },
					},
				};
			},
		);
		expect(outcome.kind).toBe("account");
		expect(generated).toEqual(["translations-generated-key-with-no-effect"]);
		expect(named).toEqual([]);
	});

	it("keeps a split list header on the right menu after a menu that could not be read", async () => {
		const source = localizationWireFixture("bilingual");
		const raw = exportedBody(source);
		const original = (raw.modules as Record<string, unknown>[])[0];
		raw.modules = [
			{ ...original, unique_id: "first-menu", forms: [] },
			menu("unread-menu", { not_a_module_key: 1 }),
			original,
		];
		const table = localAppStringTable(source, []);
		const first = Object.keys(table.languages.en).find(
			(key) => key.includes("case_short") && table.languages.en[key] === "Age",
		);
		if (!first) throw Error("The control needs the list's age column");
		const third = first.replace("m0.", "m2.");
		const strings = raw.translations as Record<string, Record<string, string>>;
		strings.en[first] = "Age";
		strings.en[third] = "Reported age";
		const outcome = readHqApp(
			await inputFor(raw, {
				appStrings: (doc) => localAppStringTable(doc, []),
			}),
			{ claims: "full" },
		);
		if (outcome.kind !== "account")
			throw Error("The middle menu should be held");
		expect([...outcome.claims.records()]).toEqual(
			expect.arrayContaining([
				// A menu with no form lists no cases, so Nova writes no string under the key.
				expect.objectContaining({
					entry:
						"application-and-settings/translations-generated-key-with-no-effect",
					at: `/translations/en/${first}`,
				}),
				expect.objectContaining({
					entry: "application-and-settings/translations-generated-wording",
					at: `/translations/en/${third}`,
				}),
			]),
		);
		expect(outcome.findings.some((f) => f.detail.name === third)).toBe(false);
	});
});
