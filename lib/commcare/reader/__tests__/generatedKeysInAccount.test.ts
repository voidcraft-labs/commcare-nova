/**
 * Generated translation keys in a whole reading.
 *
 * Contract: every generated key is decided in the reading that meets it. A
 * key whose menu read whole is classified, against the string of the
 * position its menu stands at in the document, even beside another menu's
 * finding; a key whose menu holds a finding, or whose language the reading
 * could not name, stands under that finding and is reported neither again nor
 * as `unrecognized`; with no table beside a finding every key stands under
 * the first finding; with no table and no finding the reader throws (C9); a
 * key that names a string the app does not make is inert; a choice's label
 * that two menus' lists show, one of them a mirror, is judged at the menu
 * that read whole and stands under the mirror's finding at the other.
 *
 * Plausible failures: a key judged against the menu that now stands at its
 * number, a covered key reported, a key left unclaimed where there is no
 * table, a clean reading whose document the gate refuses returned.
 */

import { describe, expect, it } from "vitest";
import {
	type BlueprintDoc,
	makeTranslationUnitId,
	type Uuid,
} from "@/lib/domain";
import { readHqApp } from "../index";
import type { AppStringTable, ReaderInput } from "../types";
import { inputFor, mirrorMenu } from "./novaExport";
import { retainedSourceBody } from "./readerInput";

const GENERATED = "translations-generated-key";

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

/** The strings Nova's build gives a document: each menu's name, under its unit. */
function menuStrings(doc: BlueprintDoc): AppStringTable {
	const languages: Record<string, string> = {};
	const units: Record<string, ReturnType<typeof makeTranslationUnitId>> = {};
	doc.moduleOrder.forEach((uuid: Uuid, index) => {
		languages[`modules.m${index}`] = doc.modules[uuid]?.name ?? "";
		units[`modules.m${index}`] = makeTranslationUnitId("module", uuid, "name");
	});
	return { languages: { en: languages }, units };
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
		expect(generated).toEqual(["translations-generated-key-over-one-text"]);
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

	it("stands under the finding at a language the reading cannot name", async () => {
		const { outcome, generated, named } = await read(
			body([menu("menu-one")], { xx: { "modules.m0": "Patients" } }, [
				"en",
				"xx",
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
});
