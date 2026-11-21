/**
 * Settings CommCare HQ stores where its build never reads them, and the shapes one cause makes,
 * read from Nova's emission edited as HQ's pages or its model would store them.
 *
 * Contract: a value HQ's build reads nowhere is claimed under the entry that names its class and
 * compared nowhere (a basic menu's `auto_select_case`, a parent selection on a menu whose step no
 * entry walks, an update map under `condition: never`, a fallback under a workflow other than
 * `form`, the child cases of a form of a multi-select menu, a form's `validation_cache`); a
 * display condition that keeps a menu or form off its menu is counted under the
 * off-the-menu entry, and is one finding at the menu where something opens that menu; a
 * `form_type` other than the form's own kind is one finding at the form.
 *
 * The plausible failures: an unread value compared through the entry facts and reported
 * `unrecognized` at the menu and its forms; a claim under a class the value is not of (the
 * "offered" fallback entry for a word the menu does not offer, the lifted-predicate entry for
 * `false()`); one cause raised as two gate differences, one at the menu and one at its form; a
 * `form_type` HQ's build dispatches on read past as held.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import {
	type AppJson,
	codesOf,
	type JsonObject,
	type MenuReading,
	moduleNamed,
	readMenusOf,
} from "./menuReading";

const M = "menus-and-case-lists";
const F = "forms-and-case-writes";

/** A registration-only menu, a menu of follow-ups, and a survey menu. */
function app(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Register",
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
							f({
								kind: "text",
								id: "village",
								caseWrite: { caseType: "patient", property: "village" },
							}),
						],
					},
				],
			},
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "notes",
								caseWrite: { caseType: "patient", property: "notes" },
							}),
						],
					},
				],
			},
			{
				name: "Tools",
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
}

const menu = (
	json: AppJson,
	index: number,
): JsonObject & { forms: JsonObject[] } =>
	json.modules[index] as JsonObject & { forms: JsonObject[] };

/** How often the reading's claim log counts `entry`. */
function counted(reading: MenuReading, entry: string): number {
	return reading.outcome.claims.counts[entry] ?? 0;
}

describe("a value CommCare HQ's build never reads", () => {
	it("holds auto_select_case on a basic menu no advanced load lists from, whatever its forms choose", async () => {
		for (const index of [0, 1]) {
			const reading = await readMenusOf(app(), (json) => {
				menu(json, index).auto_select_case = true;
			});
			expect(codesOf(reading)).toEqual([]);
			expect(
				counted(
					reading,
					`${M}/auto-select-case-true-on-any-other-basic-module`,
				),
			).toBe(1);
		}
	});

	it("holds a parent selection naming a survey menu on a menu whose step no entry walks", async () => {
		const reading = await readMenusOf(app(), (json) => {
			menu(json, 0).parent_select = {
				active: true,
				relationship: "parent",
				module_id: menu(json, 2).unique_id,
				doc_type: "ParentSelect",
			};
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			counted(
				reading,
				`${M}/parent-select-naming-a-survey-module-on-a-child-that-does-not`,
			),
		).toBe(1);
	});

	it("drops an update map left under condition never as inert", async () => {
		const reading = await readMenusOf(app(), (json) => {
			const actions = menu(json, 0).forms[0]?.actions as JsonObject;
			const update = actions.update_case as JsonObject;
			expect(Object.keys(update.update as JsonObject)).toEqual(["village"]);
			update.condition = { ...(update.condition as JsonObject), type: "never" };
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			counted(reading, `${F}/update-case-update-map-under-condition-never`),
		).toBe(1);
	});

	it("drops a child case of a multi-select menu's form, whose datum nothing reads, with no entry fact left over", async () => {
		const reading = await readMenusOf(app(), (json) => {
			const details = menu(json, 1).case_details as JsonObject;
			(details.short as JsonObject).multi_select = true;
			// The screen before is not offered beside a list of several cases.
			(menu(json, 1).forms[0] as JsonObject).post_form_workflow = "module";
			const actions = menu(json, 1).forms[0]?.actions as JsonObject;
			actions.subcases = [
				{
					doc_type: "OpenSubCaseAction",
					case_type: "patient",
					name_update: { question_path: "/data/notes" },
					case_properties: {},
					reference_id: "parent",
					relationship: "child",
					repeat_context: "",
					condition: { type: "always", doc_type: "FormActionCondition" },
					close_condition: { type: "never", doc_type: "FormActionCondition" },
				},
			];
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			counted(
				reading,
				`${F}/subcases-on-such-a-form-in-an-app-that-does-not-share-cases-or`,
			),
		).toBe(1);
	});

	it("claims a fallback under a workflow other than form by whether the menu offers it", async () => {
		const outside = await readMenusOf(app(), (json) => {
			menu(json, 1).forms[0] = {
				...menu(json, 1).forms[0],
				post_form_workflow: "default",
				post_form_workflow_fallback: "parent_module",
			};
		});
		expect(codesOf(outside)).toEqual([]);
		expect(
			counted(
				outside,
				`${F}/post-form-workflow-fallback-outside-the-offered-set-anywhere`,
			),
		).toBe(1);
		const offered = await readMenusOf(app(), (json) => {
			menu(json, 1).forms[0] = {
				...menu(json, 1).forms[0],
				post_form_workflow: "default",
				post_form_workflow_fallback: "module",
			};
		});
		expect(codesOf(offered)).toEqual([]);
		expect(
			counted(
				offered,
				`${F}/post-form-workflow-fallback-offered-in-that-menu-set-where-no`,
			),
		).toBe(1);
	});
});

describe("a display condition that keeps a menu or a form off its menu", () => {
	it("is counted under the off-the-menu entries, not the lifted condition's", async () => {
		const reading = await readMenusOf(app(), (json) => {
			menu(json, 2).module_filter = "false()";
			const form = menu(json, 1).forms[0] as JsonObject;
			form.form_filter = "false()";
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Tools").hiddenFromMenu,
		).toBe(true);
		expect(
			counted(
				reading,
				`${M}/module-filter-false-or-false-and-rest-menu-reached-only-by-links`,
			),
		).toBe(1);
		expect(
			counted(
				reading,
				`${M}/form-filter-false-or-false-and-rest-form-reached-only-by-links`,
			),
		).toBe(1);
		expect(
			counted(reading, `${M}/module-filter-value-lifts-into-predicate`),
		).toBe(0);
	});

	it("is one finding at the menu where a form returns to that menu", async () => {
		const reading = await readMenusOf(app(), (json) => {
			menu(json, 1).module_filter = "false()";
			menu(json, 1).forms[0] = {
				...menu(json, 1).forms[0],
				post_form_workflow: "module",
			};
		});
		expect(codesOf(reading)).toEqual([
			`${M}/module-filter-false-on-a-menu-something-opens`,
		]);
		expect(reading.findings[0]?.place).toMatchObject({ kind: "menu", menu: 1 });
	});
});

describe("a form's validation_cache", () => {
	it("is claimed once, though no declared key holds it", async () => {
		// HQ's `FormBase.wrap` pops it, so its model declares no such key.
		const reading = await readMenusOf(app(), (json) => {
			(menu(json, 0).forms[0] as JsonObject).validation_cache = "cached";
		});
		expect(reading.outcome.defects).toEqual([]);
		expect(codesOf(reading)).toEqual([]);
	});
});

describe("a form's form_type", () => {
	it("is one finding at the form where it is another kind's, and counted at its own kind", async () => {
		const own = await readMenusOf(app());
		expect(codesOf(own)).toEqual([]);
		expect(counted(own, `${F}/form-type`)).toBeGreaterThan(0);
		const other = await readMenusOf(app(), (json) => {
			(menu(json, 1).forms[0] as JsonObject).form_type = "advanced_form";
		});
		expect(codesOf(other)).toEqual([
			`${F}/form-type-other-than-the-form-s-own-kind`,
		]);
		expect(other.findings[0]?.place).toMatchObject({
			kind: "form",
			menu: 1,
			form: 0,
		});
	});
});
