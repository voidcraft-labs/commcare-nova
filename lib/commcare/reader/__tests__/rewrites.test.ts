/**
 * The same-state rules of the case management, menu, after-submit, case list
 * and search readers, and the first-publish register's rows they fall under.
 *
 * Contract: each rule a comparison applies (a key left out of, or mapped
 * before, the re-emission) appends `{ entry, path, register }` to
 * `ReadFacts.sameStateRewrites`, with `register` one of the register's rows
 * these readers hand it; and a reading that applies one rule once lists that
 * rule's row once. Two readings record under rows of their own, which the
 * register words and holds by its own test: a date and time saved in the
 * spelling Nova wrote before, and a Register label with no text. The
 * plausible failure: a source rewrite the first publish makes with no
 * register row, so the lane finds a difference no entry holds.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, SearchInputDef } from "@/lib/domain";
import {
	eq,
	input,
	literal,
	neq,
	prop,
	whenInput,
} from "@/lib/domain/expression/builders";
import {
	columnSort,
	NO_SEARCH_SCREEN_TITLE,
	plainColumn,
} from "@/lib/domain/modules";
import {
	advancedFixture,
	OP,
	read,
	U,
} from "../../__tests__/advancedPlacementFixture";
import { buildShape } from "../../__tests__/formLinkDocArbitrary";
import { patients, uuid } from "../caseList/__tests__/fixtures";
import { readLists } from "../caseList/__tests__/listReading";
import { readCases } from "../caseManagement/__tests__/caseReading";
import { type JsonObject, readMenusOf } from "../menus/__tests__/menuReading";
import type { ReadFacts } from "../types";

/** The rows of the first-publish register these readers hand it (the register's own words). */
const REGISTER_ROWS = new Set([
	"case-settings-respelled",
	"search-filter-rows-recut",
	"sort-rule-kept-as-hidden-column",
	"list-settings-respelled",
	"search-filter-joined-to-list",
	"search-restates-list-filter",
	"link-held-case-guards-added",
]);

/** The two rows the register words for readings outside this table. */
const OWN_ROWS = new Set([
	"date-and-time-saved-as-hq-stores-it",
	"registration-label-fixed",
]);

type Rewrites = ReadFacts["sameStateRewrites"];

function registersOf(rewrites: Rewrites): string[] {
	for (const one of rewrites) {
		expect(
			REGISTER_ROWS.has(one.register) || OWN_ROWS.has(one.register),
			one.register,
		).toBe(true);
		expect(one.path.startsWith("/"), one.path).toBe(true);
		expect(one.entry).toMatch(/^[a-z-]+\/[a-z0-9-]+$/);
	}
	return rewrites
		.map((one) => one.register)
		.filter((register) => REGISTER_ROWS.has(register));
}

async function menuRewrites(
	doc: BlueprintDoc,
	edit: (app: { modules: JsonObject[] } & JsonObject) => void,
) {
	const reading = await readMenusOf(doc, edit as never);
	expect(reading.findings).toEqual([]);
	return reading.outcome.kind === "read"
		? reading.outcome.draft.facts.sameStateRewrites
		: [];
}

const visit = {
	name: "Visit",
	type: "followup" as const,
	fields: [
		f({
			kind: "text",
			id: "notes",
			caseWrite: { caseType: "patient", property: "notes" },
		}),
		f({ kind: "text", id: "other" }),
	],
};

const CASES: {
	readonly section: string;
	readonly register: string;
	readonly rewrites: () => Promise<Rewrites>;
}[] = [
	{
		section: "3.5, an own update's `if` condition",
		register: "case-settings-respelled",
		rewrites: async () =>
			(
				await readCases(
					buildDoc({
						modules: [
							{ name: "Patients", caseType: "patient", forms: [visit] },
						],
					}),
					{
						edit: (app) => {
							const actions = app.modules[0]?.forms[0]?.actions as Record<
								string,
								Record<string, unknown>
							>;
							(actions.update_case as Record<string, unknown>).condition = {
								type: "if",
								question: "/data/other",
								answer: "x",
								operator: "=",
								doc_type: "FormActionCondition",
							};
						},
					},
				)
			).ctx.facts.sameStateRewrites,
	},
	{
		section: "4.4, an open action's name saved only if changed",
		register: "case-settings-respelled",
		rewrites: async () => {
			const { doc } = advancedFixture({
				formType: "registration",
				operations: () => [
					{
						uuid: OP("own"),
						id: "household",
						action: "own",
						name: read("name"),
					},
					{
						uuid: OP("kid"),
						id: "member",
						action: "create",
						caseType: "member",
						target: { kind: "new" },
						name: read("kid_name"),
						forEach: { repeat: U("kids") },
						links: [
							{
								identifier: "parent",
								targetType: "household",
								target: { kind: "op", opUuid: OP("own") },
								relationship: "child",
							},
						],
					},
				],
			});
			const reading = await readCases(doc, {
				edit: (app) => {
					for (const module of app.modules)
						for (const form of module.forms) {
							const opens =
								(form.actions as { open_cases?: Record<string, unknown>[] })
									.open_cases ?? [];
							const kid = opens.find((one) => one.case_type === "member");
							if (kid !== undefined)
								(kid.name_update as Record<string, unknown>).update_mode =
									"edit";
						}
				},
			});
			return reading.ctx.facts.sameStateRewrites;
		},
	},
	{
		section: "8.6, a case list menu item's label blank in every language",
		register: "list-settings-respelled",
		rewrites: () =>
			menuRewrites(
				buildDoc({
					modules: [
						{
							name: "Patients",
							caseType: "patient",
							caseListMenuItem: {},
							forms: [visit],
						},
					],
				}),
				(app) => {
					(app.modules[0]?.case_list as JsonObject).label = { en: "" };
				},
			),
	},
	{
		section: "9.5, a link that carries a case with no guard",
		register: "link-held-case-guards-added",
		rewrites: () =>
			menuRewrites(
				buildShape([{ carry: "c0", toMenu: false }], { kind: "none" }),
				(app) => {
					const forms = (app.modules[0]?.forms ?? []) as JsonObject[];
					const [first] = (forms[0]?.form_links ?? []) as JsonObject[];
					if (first !== undefined) first.xpath = "";
				},
			),
	},
	{
		section: "11.1, a several-case list's `max_select_value` of -1",
		register: "list-settings-respelled",
		rewrites: async () =>
			(
				await readLists(
					patients([plainColumn(uuid(1), "case_name", "Name")], {
						list: { selection: { kind: "multiple", maximum: 100 } },
					}),
					{
						edit: (app) => {
							(
								app.modules[0]?.case_details.short as Record<string, unknown>
							).max_select_value = -1;
						},
					},
				)
			).ctx.facts.sameStateRewrites,
	},
	{
		section: "11.4, a sort element's `type: string`",
		register: "sort-rule-kept-as-hidden-column",
		rewrites: async () =>
			(
				await readLists(
					patients([
						plainColumn(uuid(1), "case_name", "Name", {
							sort: columnSort("asc", 0),
						}),
					]),
					{
						edit: (app) => {
							const first = app.modules[0]?.case_details.short.sort_elements[0];
							if (first !== undefined) first.type = "string";
						},
					},
				)
			).ctx.facts.sameStateRewrites,
	},
	{
		section: "12.3, `_xpath_query` rows in another order",
		register: "search-filter-rows-recut",
		rewrites: async () => {
			const condition = whenInput(
				input(uuid(9)),
				neq(prop("patient", "phone"), input(uuid(9))),
			);
			const field: SearchInputDef = {
				uuid: uuid(9),
				name: "number",
				label: "Number",
				kind: "advanced",
				type: "text",
				predicate: condition,
			};
			const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [field],
				search: {},
				list: { filter: eq(prop("patient", "notes"), literal("open")) },
			});
			return (
				await readLists(doc, {
					edit: (app) => {
						const rows = app.modules[0]?.search_config.default_properties;
						if (Array.isArray(rows)) rows.reverse();
					},
				})
			).ctx.facts.sameStateRewrites;
		},
	},
	{
		section: "12.4, a search title of `{}`",
		register: "list-settings-respelled",
		rewrites: async () =>
			(
				await readLists(
					patients([plainColumn(uuid(1), "case_name", "Name")], {
						searchInputs: [
							{
								uuid: uuid(9),
								name: "notes",
								label: "Notes",
								kind: "simple",
								type: "text",
								property: "notes",
							},
						],
						search: { searchScreenTitle: NO_SEARCH_SCREEN_TITLE },
					}),
					{
						edit: (app) => {
							const config = app.modules[0]?.search_config;
							if (config !== undefined) config.title_label = {};
						},
					},
				)
			).ctx.facts.sameStateRewrites,
	},
];

describe("the same-state rules and the first-publish register", () => {
	for (const { section, register, rewrites } of CASES)
		it(`records ${section} once, under ${register}`, async () => {
			expect(registersOf(await rewrites())).toEqual([register]);
		});
});
