/**
 * The same-state rules of the case management, menu, after-submit, case list
 * and search readers, and the first-publish register's rows they fall under.
 *
 * Contract: each rule a comparison applies (a key left out of, or mapped
 * before, the re-emission) appends `{ entry, path, register }` to
 * `ReadFacts.sameStateRewrites`, with `register` one of the register's rows
 * these readers hand it; and a reading that applies one rule once lists that
 * rule's row once. The rows are `types.ts::SAME_STATE_REGISTERS`, and every
 * one of them is read by a case here, so a row added to that list without a
 * reading that records it fails. Other readings record under rows of their own
 * (`FIRST_PUBLISH_READING_RECORDS`), which the
 * register words and holds by its own test: a date and time saved in the
 * spelling Nova wrote before, a Register label with no text, a menu's or
 * form's name map Nova prints another way (`names.test.ts`), any app string
 * held so that a worker reads another text (`text-spaces-dropped`, over every
 * surface in `heldTexts.test.ts`), and a media map Nova prints another way
 * (`menus/__tests__/navMedia.test.ts`). The
 * plausible failure: a source rewrite the first publish makes with no
 * register row, so the lane finds a difference no entry holds.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, SearchInputDef } from "@/lib/domain";
import {
	and,
	concat,
	eq,
	input,
	literal,
	neq,
	prop,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import {
	type CaseListConfig,
	type CaseSearchConfig,
	calculatedColumn,
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
import {
	codes,
	type AppJson as ListAppJson,
	readLists,
} from "../caseList/__tests__/listReading";
import { readCases } from "../caseManagement/__tests__/caseReading";
import { type JsonObject, readMenusOf } from "../menus/__tests__/menuReading";
import {
	FIRST_PUBLISH_READING_RECORDS,
	type ReadFacts,
	SAME_STATE_REGISTERS,
} from "../types";

/** The rows of the first-publish register these readers hand it. */
const REGISTER_ROWS: ReadonlySet<string> = new Set(SAME_STATE_REGISTERS);

/** The rows the register words for readings outside this table. */
const OWN_ROWS: ReadonlySet<string> = new Set(FIRST_PUBLISH_READING_RECORDS);

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

/** A reading of a case list or a search, held to read as the same state, with no finding. */
async function listRewrites(
	doc: BlueprintDoc,
	edit: (app: ListAppJson) => void,
) {
	const reading = await readLists(doc, { edit });
	expect(codes(reading)).toEqual([]);
	return reading.ctx.facts.sameStateRewrites;
}

const notesIs = (value: string) => eq(prop("patient", "notes"), literal(value));

/** One menu of patients, its list filtered as given, searched by a field over `phone`. */
function searched(
	search: CaseSearchConfig,
	filter: NonNullable<CaseListConfig["filter"]>,
) {
	const phone: SearchInputDef = {
		uuid: uuid(9),
		name: "phone",
		label: "Phone",
		kind: "simple",
		type: "text",
		property: "phone",
	};
	return patients([plainColumn(uuid(1), "case_name", "Name")], {
		searchInputs: [phone],
		search,
		list: { filter },
	});
}

/** The app's one menu, as the emitter wrote it. */
function firstModule(app: ListAppJson) {
	const module = app.modules[0];
	if (module === undefined) throw new Error("The app holds one menu.");
	return module;
}

/** The stored `_xpath_query` rows of the first menu's search. */
const rowsOf = (app: ListAppJson) =>
	firstModule(app).search_config.default_properties as Record<
		string,
		unknown
	>[];

/** The first menu's case list, holding one sorted column. */
const sortedList = () =>
	patients([
		plainColumn(uuid(1), "case_name", "Name", { sort: columnSort("asc", 0) }),
	]);

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
	...(
		[
			["++name:exact", "search-order-direction-signs-respelled"],
			["+name:exact:obsolete", "search-order-unused-suffix-removed"],
		] as const
	).map(([value, register]) => ({
		section: `a default Search sort of ${value}`,
		register,
		rewrites: () =>
			listRewrites(patients([], { search: {} }), (app) => {
				firstModule(app).search_config.default_properties = [
					{ property: "commcare_sort", defaultValue: `'${value}'` },
				];
			}),
	})),
	{
		section: "an unused suffix on an address receiver",
		register: "search-address-receiver-suffix-removed",
		rewrites: () =>
			listRewrites(searched({}, notesIs("open")), (app) => {
				app.cloudcare_enabled = true;
				const search = firstModule(app).search_config;
				const prompts = search.properties as Record<string, unknown>[];
				prompts[0].receiver_expression = "home-city-extra";
				prompts.unshift({
					name: "home",
					doc_type: "CaseSearchProperty",
					label: { en: "Find an address" },
					appearance: "address",
					exclude: true,
				});
			}),
	},
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
		rewrites: () =>
			listRewrites(
				patients([plainColumn(uuid(1), "case_name", "Name")], {
					list: { selection: { kind: "multiple", maximum: 100 } },
				}),
				(app) => {
					firstModule(app).case_details.short.max_select_value = -1;
				},
			),
	},
	{
		section: "11.4, a sort element no column joins",
		register: "sort-rule-kept-as-hidden-column",
		rewrites: () =>
			listRewrites(sortedList(), (app) => {
				const first = app.modules[0]?.case_details.short.sort_elements[0];
				if (first !== undefined) first.field = "phone";
			}),
	},
	{
		section: "11.4, a sort element's `type: string` on a column the list shows",
		register: "list-settings-respelled",
		rewrites: () =>
			listRewrites(sortedList(), (app) => {
				const first = app.modules[0]?.case_details.short.sort_elements[0];
				if (first !== undefined) first.type = "string";
			}),
	},
	{
		// HQ's build writes `date` over a property that is not of the date class as it writes
		// `plain` (`detail_screen.py::FormattedDetailColumn.sort_node`), and the first publish
		// writes `plain`: no hidden column is added, so the hidden-column row must not apply.
		section:
			"11.4, a sort element's `type: date` on a shown column Nova writes `plain`",
		register: "list-settings-respelled",
		rewrites: () =>
			listRewrites(sortedList(), (app) => {
				const first = app.modules[0]?.case_details.short.sort_elements[0];
				if (first !== undefined) first.type = "date";
			}),
	},
	{
		section: '11.4, a sort element\'s `blanks` of `""`',
		register: "list-settings-respelled",
		rewrites: () =>
			listRewrites(sortedList(), (app) => {
				const first = app.modules[0]?.case_details.short.sort_elements[0];
				if (first !== undefined) first.blanks = "";
			}),
	},
	{
		section:
			"11.4, an earlier sort element a later one with its `field` replaces",
		register: "list-settings-respelled",
		rewrites: () =>
			listRewrites(sortedList(), (app) => {
				const elements = app.modules[0]?.case_details.short.sort_elements;
				const first = elements?.[0];
				if (first !== undefined)
					elements?.unshift({ ...first, direction: "descending" });
			}),
	},
	{
		section: "11.4, a `sort_calculation` equal to the column its element joins",
		register: "list-settings-respelled",
		rewrites: () =>
			listRewrites(
				patients([
					calculatedColumn(
						uuid(7),
						"Twice",
						concat(
							term(prop("patient", "case_name")),
							term(prop("patient", "case_name")),
						),
						{ sort: columnSort("asc", 0) },
					),
				]),
				(app) => {
					const short = app.modules[0]?.case_details.short;
					const first = short?.sort_elements[0];
					if (first !== undefined)
						first.sort_calculation = short?.columns[0]?.field;
				},
			),
	},
	{
		section: "12.3, `_xpath_query` rows in another order",
		register: "search-filter-rows-recut",
		rewrites: () => {
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
				list: { filter: notesIs("open") },
			});
			return listRewrites(doc, (app) => {
				rowsOf(app).reverse();
			});
		},
	},
	{
		section: "12.3, one `_xpath_query` row whose text is an `and` of two",
		register: "search-filter-rows-recut",
		rewrites: () =>
			listRewrites(
				searched({}, and(notesIs("open"), notesIs("closed"))),
				(app) => {
					const rows = rowsOf(app);
					// A row's value is an XPath whose value is the CSQL text, as Nova writes
					// `"notes = 'open'"`.
					expect(rows.map((one) => one.defaultValue)).toEqual([
						`"notes = 'open'"`,
						`"notes = 'closed'"`,
					]);
					const [first] = rows;
					if (first !== undefined)
						rows.splice(0, rows.length, {
							...first,
							defaultValue: `"notes = 'open' and notes = 'closed'"`,
						});
				},
			),
	},
	{
		section: "12.4, a search title of `{}`",
		register: "list-settings-respelled",
		rewrites: () =>
			listRewrites(
				searched(
					{ searchScreenTitle: NO_SEARCH_SCREEN_TITLE },
					notesIs("open"),
				),
				(app) => {
					firstModule(app).search_config.title_label = {};
				},
			),
	},
	{
		section: "12.4, a search description blank and missing the app's language",
		register: "list-settings-respelled",
		rewrites: () =>
			listRewrites(searched({}, notesIs("open")), (app) => {
				firstModule(app).search_config.description = { fra: "" };
			}),
	},
	{
		section: "translatable text from a saved related record column",
		register: "legacy-related-case-text-rekeyed",
		rewrites: () =>
			listRewrites(
				patients([plainColumn(uuid(1), "case_name", "Name")]),
				(app) => {
					Object.assign(firstModule(app).case_details.short.columns[0], {
						field: "parent/case_name",
						format: "translatable-enum",
						useXpathExpression: false,
						enum: [
							{
								doc_type: "MappingItem",
								key: "guide",
								value: { en: "Guide" },
								alt_text: {},
							},
						],
					});
				},
			),
	},
];

describe("the same-state rules and the first-publish register", () => {
	for (const { section, register, rewrites } of CASES)
		it(`records ${section} once, under ${register}`, async () => {
			expect(registersOf(await rewrites())).toEqual([register]);
		});

	it("reads a case for every row these readers hand the register", () => {
		expect(new Set(CASES.map((one) => one.register))).toEqual(REGISTER_ROWS);
	});
});
