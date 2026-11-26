/**
 * Menus and forms at their own keys, over hand-built apps on CommCare HQ's
 * own shell.
 *
 * It would catch a supported source-backed menu being rejected before its form references are read; two
 * forms of one `xmlns` both minted; a report menu's and a shadow form's
 * findings not both in one account; a menu with no id or a form whose
 * `xmlns` is blank minted; a form named `instance('casedb') practice`
 * read to anything but the one finding `form-name-read-as-an-instance`; and
 * an advanced menu's or form's class recorded nowhere the lane records it
 * (the object's own pointer), or an advanced form's dynamic keys left for
 * the close; and the legacy labels HQ's agriculture template carries on a
 * menu refused as undeclared keys, or any other undeclared key let through.
 */

import { describe, expect, it } from "vitest";
import { applicationReading, readApplication } from "../appShell";
import { externalKey, mintEntityUuid } from "../identity";
import { readStructure } from "../structure";
import {
	closeAfterStructure,
	entriesAt,
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

	it("drops the legacy labels HQ's agriculture template carries on a menu, and refuses any other undeclared key", async () => {
		const legacy = {
			referral_label: { en: "Referrals" },
			case_label: { en: "Cases" },
		};
		const { ctx, closed } = await readMenus([
			menu("m-legacy", "Visits", [], legacy),
		]);
		expect(closed.findings).toEqual([]);
		expect(entriesAt(closed, "/modules/0/referral_label")).toEqual([
			`${M}/module-referral-label-case-label`,
		]);
		expect(entriesAt(closed, "/modules/0/case_label")).toEqual([
			`${M}/module-referral-label-case-label`,
		]);
		expect(ctx.draft.modules).toHaveLength(1);
		const planted = await readMenus([
			menu("m-planted", "Visits", [], { planted_label: { en: "x" } }),
		]);
		expect(planted.closed.findings.map((one) => one.code)).toEqual([
			`${M}/any-other-undeclared-key`,
		]);
	});

	it("reads an advanced menu's and form's class at the object itself, and an advanced form's dynamic keys as a form's", async () => {
		const xmlns = "http://openrosa.org/formdesigner/advanced";
		const { ctx, closed } = await readMenus([
			menu(
				"m-advanced",
				"Advanced",
				[
					form("r1", xmlns, "Visit", {
						doc_type: "AdvancedForm",
						no_vellum: true,
						put_in_root: false,
						planted: 1,
					}),
				],
				{ doc_type: "AdvancedModule" },
			),
		]);
		expect(entriesAt(closed, "/modules/0")).toEqual([`${M}/advancedmodule`]);
		expect(entriesAt(closed, "/modules/0/forms/0")).toEqual([
			`${F}/advancedform`,
		]);
		expect(entriesAt(closed, "/modules/0/forms/0/no_vellum")).toEqual([
			`${F}/no-vellum-removed-field-dynamic-key`,
		]);
		expect(entriesAt(closed, "/modules/0/forms/0/put_in_root")).toEqual([
			`${F}/put-in-root-on-a-form-dynamic-key`,
		]);
		expect(
			closed.findings.filter((finding) => finding.place.kind === "form"),
		).toMatchObject([
			{
				code: `${F}/any-other-undeclared-key`,
				place: { kind: "form", menu: 0, form: 0 },
				detail: { name: "planted" },
			},
		]);
		expect(ctx.draft.modules[0]).toMatchObject({
			docType: "AdvancedModule",
			forms: [{ docType: "AdvancedForm" }],
		});
	});

	it("reads a basic menu's class at the object itself, a case list menu where it names a case type and a survey menu where it names none", async () => {
		const { closed } = await readMenus([
			menu("m-list", "Households", [], { case_type: "household" }),
			menu("m-survey", "Surveys", [], { case_type: "" }),
			menu("m-unset", "Unset"),
		]);
		expect(entriesAt(closed, "/modules/0")).toEqual([
			`${M}/module-with-case-type-case-list-module`,
		]);
		expect(entriesAt(closed, "/modules/1")).toEqual([
			`${M}/module-with-case-type-survey-module`,
		]);
		expect(entriesAt(closed, "/modules/2")).toEqual([
			`${M}/module-with-case-type-survey-module`,
		]);
		const missing = await readMenus([
			menu(null, "No id", [], { case_type: "household" }),
		]);
		expect(entriesAt(missing.closed, "/modules/0")).toEqual([
			`${M}/module-unique-id-missing`,
		]);
	});

	it("claims a version 2 menu and indexes it for reading its own settings and source forms", async () => {
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
			},
		]);
		expect(entriesAt(closed, "/modules/1")).toContain(
			`${M}/shadowmodule-shadow-module-version-2`,
		);
		expect(ctx.draft.modules.map((draft) => draft.uniqueId)).toEqual([
			"m-source",
			"m-mirror",
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
			ctx.identities.entries().filter((entry) => entry.kind === "form"),
		).toEqual([]);
		expect(ctx.draft.modules.flatMap((draft) => draft.forms)).toEqual([]);
	});

	it("reports both an ineligible shared parent and a report menu", async () => {
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
				code: `${F}/shadow-parent-form-id-naming-a-basic-form-or-another-shadowform`,
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
