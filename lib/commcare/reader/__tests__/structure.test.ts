/**
 * Menus and forms at their own keys, over hand-built apps on CommCare HQ's
 * own shell.
 *
 * It would catch a mirror menu read key by key into dozens of findings; two
 * forms of one `xmlns` both minted; a report menu's and a shadow form's
 * findings not both in one account; a menu with no id or a form whose
 * `xmlns` is blank minted; and a form named `instance('casedb') practice`
 * read to anything but the one finding `form-name-read-as-an-instance`.
 */

import { describe, expect, it } from "vitest";
import { applicationReading, readApplication } from "../appShell";
import { externalKey, mintEntityUuid } from "../identity";
import { readStructure } from "../structure";
import {
	closeAfterStructure,
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "./readerInput";

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";

function menu(
	uniqueId: string | null,
	name: string,
	forms: readonly Record<string, unknown>[] = [],
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		doc_type: "Module",
		...(uniqueId === null ? {} : { unique_id: uniqueId }),
		name: { en: name },
		case_type: null,
		forms,
		...extra,
	};
}

function form(
	readId: string,
	xmlns: string | null,
	name: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		doc_type: "Form",
		unique_id: readId,
		xmlns,
		name: { en: name },
		...extra,
	};
}

async function readMenus(modules: readonly Record<string, unknown>[]) {
	const ctx = readContext(
		readerInput(
			await sourceFromBody({
				...retainedSourceBody("shell/app-source"),
				modules,
				_attachments: {},
			}),
		),
	);
	readApplication(ctx);
	readStructure(ctx);
	expect(applicationReading(ctx)?.attachments).toBeUndefined();
	return { ctx, closed: closeAfterStructure(ctx) };
}

describe("readStructure", () => {
	it("mints each menu and form by its id in HQ's order and reads its own record", async () => {
		const xmlns = "http://openrosa.org/formdesigner/visit";
		const { ctx, closed } = await readMenus([
			menu("m-one", "Visits", [form("r1", xmlns, "Visit")]),
		]);
		expect(closed.findings).toEqual([]);
		const [draft] = ctx.draft.modules;
		expect(draft).toMatchObject({
			index: 0,
			uniqueId: "m-one",
			uuid: mintEntityUuid("app-1", externalKey.module("m-one")),
			docType: "Module",
			module: { name: "Visits" },
		});
		expect(draft?.forms).toMatchObject([
			{
				menu: 0,
				index: 0,
				xmlns,
				uuid: mintEntityUuid("app-1", externalKey.form(xmlns)),
				docType: "Form",
				form: { name: "Visit" },
				xform: null,
			},
		]);
	});

	it("gives a mirror menu one finding at the menu, whatever it holds", async () => {
		const { ctx, closed } = await readMenus([
			menu("m-source", "Source"),
			{
				doc_type: "ShadowModule",
				unique_id: "m-mirror",
				name: { en: "Mirror" },
				case_type: null,
				forms: [],
				shadow_module_version: 2,
				source_module_id: "m-source",
				case_details: { short: { columns: [{ field: "name" }] } },
				put_in_root: true,
				excluded_form_ids: ["x"],
				planted: 1,
			},
		]);
		expect(closed.findings).toMatchObject([
			{
				code: `${M}/shadowmodule-shadow-module-version-2`,
				place: { kind: "menu", menu: 1, name: "Mirror" },
			},
		]);
		expect(ctx.draft.modules.map((draft) => draft.uniqueId)).toEqual([
			"m-source",
		]);
	});

	it("reads a version 1 mirror and a mirror of no menu under their own entries", async () => {
		const mirror = (id: string, version: number, source: string) => ({
			doc_type: "ShadowModule",
			unique_id: id,
			name: { en: id },
			case_type: null,
			forms: [],
			shadow_module_version: version,
			source_module_id: source,
		});
		const { closed } = await readMenus([
			menu("m-source", "Source"),
			mirror("m-old", 1, "m-source"),
			mirror("m-lost", 2, "m-gone"),
		]);
		expect(closed.findings.map((finding) => finding.code)).toEqual([
			`${M}/shadowmodule-version-1-or-key-absent-model-default-1`,
			`${M}/shadowmodule-with-no-source-module-id-or-one-naming-no-module`,
		]);
	});

	it("refuses both forms of one xmlns and mints neither", async () => {
		const xmlns = "http://openrosa.org/formdesigner/shared";
		const { ctx, closed } = await readMenus([
			menu("m-one", "One", [form("r1", xmlns, "First")]),
			menu("m-two", "Two", [form("r2", xmlns, "Second")]),
		]);
		expect(closed.findings).toMatchObject([
			{
				code: `${F}/two-non-shadow-forms-sharing-an-xmlns`,
				place: { kind: "form", menu: 0, form: 0 },
			},
			{
				code: `${F}/two-non-shadow-forms-sharing-an-xmlns`,
				place: { kind: "form", menu: 1, form: 0 },
			},
		]);
		expect(
			ctx.resolver.entries().filter((entry) => entry.kind === "form"),
		).toEqual([]);
		expect(ctx.draft.modules.flatMap((draft) => draft.forms)).toEqual([]);
	});

	it("puts a report menu's and a shadow form's findings in one account", async () => {
		const { closed } = await readMenus([
			menu("m-one", "One", [
				form("r1", "http://openrosa.org/formdesigner/one", "One"),
				{
					doc_type: "ShadowForm",
					unique_id: "r2",
					xmlns: null,
					name: { en: "Again" },
					shadow_parent_form_id: "r1",
				},
			]),
			{
				doc_type: "ReportModule",
				unique_id: "m-report",
				name: { en: "Reports" },
				case_type: null,
				forms: [],
				report_configs: [{ report_id: "r" }],
			},
		]);
		expect(closed.findings).toMatchObject([
			{
				code: `${F}/shadowform`,
				place: { kind: "form", menu: 0, form: 1 },
			},
			{
				code: `${M}/reportmodule-mobile-ucr-and-all-of-report-configs`,
				place: { kind: "menu", menu: 1 },
			},
		]);
	});

	it("refuses a menu with no id and a form whose xmlns is blank, minting neither", async () => {
		const { ctx, closed } = await readMenus([
			menu(null, "Unsaved"),
			menu("m-two", "Two", [form("r1", null, "Broken")]),
		]);
		expect(closed.findings).toMatchObject([
			{
				code: `${M}/module-unique-id-missing`,
				place: { kind: "menu", menu: 0 },
			},
			{
				code: `${F}/blank-source-or-no-non-group-question`,
				place: { kind: "form", menu: 1, form: 0 },
			},
		]);
		expect(ctx.draft.modules.map((draft) => draft.uniqueId)).toEqual(["m-two"]);
		expect(ctx.draft.modules[0]?.forms).toEqual([]);
	});

	it("reads a form whose name CommCare HQ's build would read as an instance to that one finding", async () => {
		const { closed } = await readMenus([
			menu("m-one", "One", [
				form(
					"r1",
					"http://openrosa.org/formdesigner/practice",
					"instance('casedb') practice",
				),
			]),
		]);
		expect(closed.findings).toEqual([
			expect.objectContaining({
				code: `${F}/form-name-read-as-an-instance`,
				place: expect.objectContaining({ kind: "form", menu: 0, form: 0 }),
				detail: { name: "instance('casedb')" },
			}),
		]);
	});

	it("puts the project space's levels on the draft, parent before child", async () => {
		const body = {
			...retainedSourceBody("shell/app-source"),
			modules: [],
		};
		const ctx = readContext(
			readerInput(await sourceFromBody(body), {
				levels: [
					{
						id: "2",
						name: "Clinic",
						code: "clinic",
						parentCode: "district",
						administrative: false,
						sharesCases: true,
						viewDescendants: false,
					},
					{
						id: "1",
						name: "District",
						code: "district",
						parentCode: null,
						administrative: true,
						sharesCases: false,
						viewDescendants: true,
					},
				],
			}),
		);
		readApplication(ctx);
		readStructure(ctx);
		expect(ctx.draft.levels.map((level) => level.code)).toEqual([
			"district",
			"clinic",
		]);
	});
});
