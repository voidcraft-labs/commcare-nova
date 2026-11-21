/**
 * A menu's or a form's setting refused under one entry claims what belongs to
 * it, so one cause in a source CommCare HQ serves is one finding.
 *
 * Contract, each over Nova's export changed as HQ's pages store the change:
 *
 * - a form's end-of-form return to a menu that shows its forms above is the
 *   form's refusal (HQ's `form link to display only forms`), and the menu's
 *   own setting is read past it;
 * - a link HQ's page does not build is refused whole: its condition is its own;
 * - a parent selection naming a menu whose case list is refused is that
 *   refusal's, never a second finding at the child;
 * - a parent selection naming a menu that searches inline is refused only
 *   under the child's own results instance name, as HQ's
 *   `validate_parent_select` compares them, and that refusal names the clash
 *   once: the search's own instance entry stands beside it only where the
 *   root menu clashes too.
 *
 * - a menu's case type the menu page would not save is its one finding: the
 *   reading keeps the stored name for the stages after it, so Nova's writer
 *   cannot write the document a comparison emits, and that is no reader
 *   defect.
 *
 * The plausible failures: the menu's `put_in_root` refused beside the form's
 * word, `unrecognized` at a refused link's `xpath`, the parent selection's
 * entry beside the case list's, and the search's instance entry beside the
 * parent selection's.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { type AppJson, codesOf, readMenusOf } from "./menuReading";

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";
const S = "case-search";

const note = (caseType: string, property: string) =>
	f({ kind: "text", id: property, caseWrite: { caseType, property } });

/** Households, with a registration, and Members, whose follow-up chooses a household first. */
function households(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "member", parent_type: "household", properties: [] },
		],
		modules: [
			{
				name: "Households",
				caseType: "household",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [note("household", "case_name")],
					},
					{
						name: "Check",
						type: "followup",
						fields: [note("household", "notes")],
					},
				],
			},
			{
				name: "Members",
				caseType: "member",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [note("member", "notes")],
					},
				],
			},
			{
				name: "Survey",
				forms: [
					{
						name: "Feedback",
						type: "survey",
						fields: [f({ kind: "text", id: "q" })],
					},
				],
			},
		],
	});
	return produce(doc, (draft) => {
		const [households, members] = draft.moduleOrder;
		const module = draft.modules[members as string];
		if (module !== undefined) module.parentCaseModuleUuid = households;
	});
}

/** An inline search on `menu`, as HQ's Case Search page stores one. */
function searchInline(app: AppJson, menu: number, instance?: string): void {
	const module = app.modules[menu] as Record<string, unknown>;
	module.search_config = {
		...(module.search_config as Record<string, unknown>),
		properties: [
			{
				doc_type: "CaseSearchProperty",
				name: "notes",
				label: { en: "Notes" },
			},
		],
		auto_launch: true,
		inline_search: true,
	};
	if (instance !== undefined)
		(
			(app.modules[menu] as Record<string, unknown>).search_config as Record<
				string,
				unknown
			>
		).instance_name = instance;
}

describe("a form's end-of-form return to a menu that shows its forms above", () => {
	it("is the form's one finding, and the menu's setting is read past it", async () => {
		const reading = await readMenusOf(households(), (app) => {
			app.modules[2].put_in_root = true;
			(app.modules[2].forms[0] as Record<string, unknown>).post_form_workflow =
				"module";
		});
		expect(codesOf(reading)).toEqual([
			`${F}/post-form-workflow-hq-s-build-refuses-module-in-a-put-in-root`,
		]);
	});
});

describe("a link HQ's page does not build", () => {
	it("is refused whole, its condition with it", async () => {
		const reading = await readMenusOf(households(), (app) => {
			const form = app.modules[0].forms[1] as Record<string, unknown>;
			form.post_form_workflow = "form";
			form.form_links = [
				{
					doc_type: "FormLink",
					xpath: "true()",
					module_unique_id: app.modules[2].unique_id,
					datums: [
						{
							doc_type: "FormDatum",
							name: "case_id",
							xpath: "instance('commcaresession')/session/data/case_id",
						},
					],
				},
			];
		});
		expect(codesOf(reading)).toEqual([
			`${F}/form-links-datums-with-other-names-or-on-a-module-target`,
		]);
	});
});

describe("a parent selection", () => {
	it("naming a menu whose case list is refused is that refusal's", async () => {
		const reading = await readMenusOf(households(), (app) => {
			// Households lists only its registration, so only the parent selection reads its list.
			app.modules[0].forms = app.modules[0].forms.slice(0, 1);
			const details = app.modules[0].case_details as Record<
				string,
				Record<string, unknown>
			>;
			details.short = { ...details.short, columns: [] };
		});
		expect(codesOf(reading)).toEqual([
			`${M}/short-columns-empty-on-a-module-another-module-s-active-parent`,
		]);
	});

	it("naming a menu that searches inline is refused under the child's own results instance name alone, once", async () => {
		const same = await readMenusOf(households(), (app) => {
			searchInline(app, 0);
		});
		expect(codesOf(same)).toContain(
			`${M}/parent-select-naming-a-module-that-searches-inline-under-the`,
		);
		expect(codesOf(same)).not.toContain(
			`${S}/a-module-whose-effective-results-instance-results-instance-name`,
		);
		const other = await readMenusOf(households(), (app) => {
			searchInline(app, 0, "households");
		});
		expect(codesOf(other)).not.toContain(
			`${M}/parent-select-naming-a-module-that-searches-inline-under-the`,
		);
	});
});

describe("a menu's case type outside the menu page's grammar", () => {
	it("is its one finding, with no reader defect for the emission it stops", async () => {
		const reading = await readMenusOf(households(), (app) => {
			app.modules[2].case_type = "membér";
		});
		expect(codesOf(reading)).toEqual([
			`${M}/case-type-outside-the-menu-page-s-grammar`,
		]);
		expect(reading.outcome.defects).toEqual([]);
	});
});
