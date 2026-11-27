/**
 * Contract: a search's title reads by language (text in every language, blank in every language
 * or `{}`, blank in the source language beside another's text raising its entry), the owner exclusion's clause leaves the list filter's
 * registered text, and the whole menu's search written back by the projection equals the stored
 * one. The failure it catches: the owner exclusion doubled in the filter; a blank title read as
 * "Search"; a setting the emitter writes back differently read as held.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { SearchInputDef } from "@/lib/domain";
import {
	concat,
	dateLiteral,
	eq,
	gt,
	gte,
	input,
	literal,
	neq,
	prop,
	sessionContext,
	term,
	today,
} from "@/lib/domain/expression/builders";
import { NO_SEARCH_SCREEN_TITLE, plainColumn } from "@/lib/domain/modules";
import { searchEmissionFixture } from "../../../__tests__/searchEmissionFixture";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	type AppJson,
	closedCodes,
	codes,
	listOf,
	readLists,
	searchOf,
} from "../../caseList/__tests__/listReading";

const field: SearchInputDef = {
	uuid: uuid(9),
	name: "notes",
	label: "Notes",
	kind: "simple",
	type: "text",
	property: "notes",
};

function doc(search: object = {}) {
	return patients([plainColumn(uuid(1), "case_name", "Name")], {
		searchInputs: [field],
		search,
	});
}

it("reconciles renamed and moved HQ heading rows through their fields", async () => {
	const fixture = searchEmissionFixture("grouped-prompts");
	const first = await readLists(fixture);
	expect(closedCodes(first)).toEqual([]);
	const prior = listOf(first);
	const edited = await readLists(fixture, {
		edit: (app) => {
			const search = app.modules[0]?.search_config;
			const rows = search?.properties;
			if (!search || !Array.isArray(rows) || rows.length !== 4)
				throw new Error("The fixture needs two Search headings");
			const moved = [...rows.slice(2), ...rows.slice(0, 2)];
			search.properties = moved.map((row, index) => {
				const group_key = index < 2 ? "group_header_0" : "group_header_2";
				return {
					...row,
					group_key,
					...(index % 2 === 0 && { name: group_key }),
				};
			});
		},
	});
	expect(closedCodes(edited)).toEqual([]);
	const current = listOf(edited);
	expect(current.searchInputGroups).toEqual(
		[...(prior.searchInputGroups ?? [])].reverse(),
	);
	expect(
		current.searchInputs.map((input) => [input.name, input.group]),
	).toEqual(
		[...prior.searchInputs].reverse().map((input) => [input.name, input.group]),
	);
});

describe("a search's settings", () => {
	it("reads a title with text, and a subtitle", async () => {
		const reading = await readLists(
			doc({
				searchScreenTitle: "Find a patient",
				searchScreenSubtitle: "By notes",
			}),
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "By notes",
		});
	});

	it("reads Nova's default title as no title slot", async () => {
		const reading = await readLists(doc());
		expect(codes(reading)).toEqual([]);
		// With nothing else set, the search holds no settings object at all.
		expect(searchOf(reading)).toBeUndefined();
	});

	it("reads a blank title as a search with no title", async () => {
		const reading = await readLists(
			doc({ searchScreenTitle: NO_SEARCH_SCREEN_TITLE }),
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			searchScreenTitle: NO_SEARCH_SCREEN_TITLE,
		});
	});

	it("reads a title of `{}` as no title and records the respelling", async () => {
		const reading = await readLists(
			doc({ searchScreenTitle: NO_SEARCH_SCREEN_TITLE }),
			{
				edit: (app) => {
					const config = app.modules[0]?.search_config;
					if (config !== undefined) config.title_label = {};
				},
			},
		);
		expect(codes(reading)).toEqual([]);
		expect(
			reading.ctx.facts.sameStateRewrites.map((one) => one.register),
		).toContain("list-settings-respelled");
	});

	it("holds a title shown blank in the source language beside another's text as no title", async () => {
		// A language with no title of its own shows the first language's, so a blank first
		// language, here the source, shows blank beside another's text: the search has no title in
		// the source, and the other language's text is its translation (`hqSaves.test.ts`).
		const reading = await readLists(doc({ searchScreenTitle: "Find" }), {
			edit: (app) => {
				(app as Record<string, unknown>).langs = ["en", "fra"];
				const config = app.modules[0]?.search_config;
				if (config !== undefined)
					config.title_label = { en: "", fra: "Trouver" };
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			searchScreenTitle: NO_SEARCH_SCREEN_TITLE,
		});
	});

	it("reads an owner exclusion, and the list filter's clause for it leaves the filter", async () => {
		const reading = await readLists(
			doc({ excludedOwnerIds: term(literal("abc")) }),
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			excludedOwnerIds: term(literal("abc")),
		});
		const registered = reading.ctx.pending.list().map((one) => one.ref.slot);
		expect(registered).not.toContain("case_list_filter");
	});

	it("reads an owner exclusion beside an authored list filter, the filter without the clause", async () => {
		const filter = neq(term(prop("patient", "notes")), term(literal("none")));
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [field],
				search: { excludedOwnerIds: term(literal("abc")) },
				list: { filter },
			}),
		);
		expect(codes(reading)).toEqual([]);
		expect(listOf(reading).filter).toEqual(filter);
		expect(searchOf(reading)).toMatchObject({
			excludedOwnerIds: term(literal("abc")),
		});
	});

	// Nova's list writes no clause for an exclusion that reads a Search answer alone, since a list
	// read before any Search sees it blank (`nodesetFilter.ts::excludedOwnerClauseWritten`); HQ's
	// build writes the list as a query datum, evaluated with the answers. The failure it catches:
	// the stored list refused as a search-only exclusion though Nova wrote it, and a Search answer
	// in the list read as one in the results detail.
	it.each([
		["a Search answer alone", true],
		["text joined to a Search answer", false],
	] as const)("reads back an owner exclusion of %s", async (_shape, alone) => {
		const answer = term(input(field.uuid));
		const reading = await readLists(
			doc({
				excludedOwnerIds: alone
					? answer
					: concat(term(literal("abc ")), answer),
			}),
		);
		expect(closedCodes(reading)).toEqual([]);
		const read = term(input(listOf(reading).searchInputs[0]?.uuid ?? ""));
		expect(searchOf(reading)?.excludedOwnerIds).toEqual(
			alone ? read : concat(term(literal("abc ")), read),
		);
	});

	it("refuses Nova's own spelling of an owner exclusion whose list clause was removed, as a value outside the search's", async () => {
		const reading = await readLists(
			doc({ excludedOwnerIds: term(literal("abc")) }),
			{
				edit: (app) => {
					const short = (
						app.modules[0] as { case_details: { short: { filter?: unknown } } }
					).case_details.short;
					short.filter = null;
				},
			},
		);
		// The setting still holds the shared rule's `normalize-space` wrapper,
		// which the search-only setting's value does not take.
		expect(closedCodes(reading)).toEqual([
			"case-search/blacklisted-owner-ids-expression-outside-valueexpression",
		]);
	});

	it("keeps search on clear unless HQ sees the case list itself auto-select", async () => {
		// HQ's `Module.is_auto_select` reads the short detail's `auto_select` whether or not the list
		// is multi-select, and never `auto_select_case`.
		const read = (
			offered: boolean,
			edit: (module: {
				auto_select_case?: boolean;
				case_details: { short: { auto_select?: boolean } };
				search_config: Record<string, unknown>;
			}) => void,
		) =>
			readLists(
				offered ? doc() : patients([plainColumn(uuid(1), "case_name", "Name")]),
				{
					edit: (app) => {
						const module = app.modules[0] as Parameters<typeof edit>[0];
						module.search_config.search_on_clear = true;
						edit(module);
					},
				},
			);
		const auto =
			"case-search/search-on-clear-with-the-case-list-s-auto-select-checked-whether";
		const own = "case-search/search-on-clear";
		const listAuto = await read(true, (module) => {
			module.case_details.short.auto_select = true;
		});
		expect(closedCodes(listAuto)).toContain(auto);
		expect(closedCodes(listAuto)).not.toContain(own);
		const caseAuto = await read(true, (module) => {
			module.auto_select_case = true;
		});
		expect(closedCodes(caseAuto)).not.toContain(own);
		expect(searchOf(caseAuto)).toMatchObject({ searchOnClear: true });
		expect(closedCodes(caseAuto)).not.toContain(auto);
		// HQ refuses it beside the list's auto select on a menu that offers no search too.
		const inactive = await read(false, (module) => {
			module.case_details.short.auto_select = true;
		});
		expect(closedCodes(inactive)).toContain(auto);
	});

	it("counts a text field with no `input_`, HQ's own default, under the text field's entry", async () => {
		const reading = await readLists(doc(), {
			edit: (app) => {
				const properties = app.modules[0]?.search_config.properties as
					| Record<string, unknown>[]
					| undefined;
				const prompt = properties?.[0];
				if (prompt === undefined) throw new Error("The search holds a field.");
				// HQ's source read leaves out an `input_` of `None` (`excludeIfNone`).
				delete prompt.input_;
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const text = [...reading.ctx.close().claims.records()].filter(
			(one) => one.entry === "case-search/text-prompt-no-input",
		);
		expect(text.map(({ where, key }) => ({ where, key }))).toEqual([
			{ where: "/modules/0/search_config/properties/0/input_", key: null },
		]);
	});

	it.each([
		["an input type no runtime names", { input_: "slider" }],
		[
			"a Mobile UCR choice list",
			{
				input_: "select1",
				itemset: {
					instance_id: "commcare-reports:abc",
					nodeset: "instance('commcare-reports:abc')/rows/row",
					label: "name",
					value: "id",
					sort: "",
				},
			},
		],
	])(
		"leaves a barcode scan beside %s under that input's refusal",
		async (_title, widget) => {
			const reading = await readLists(doc(), {
				edit: (app) => {
					const prompt = (
						app.modules[0]?.search_config.properties as
							| Record<string, unknown>[]
							| undefined
					)?.[0];
					if (prompt === undefined)
						throw new Error("The search holds a field.");
					Object.assign(prompt, widget, { appearance: "barcode_scan" });
				},
			});
			const records = [...reading.ctx.close().claims.records()];
			const at = (key: string) =>
				records.find(
					(one) => one.where === `/modules/0/search_config/properties/0/${key}`,
				)?.entry;
			expect(
				records.some(
					(one) => one.entry === "case-search/appearance-barcode-scan",
				),
			).toBe(false);
			expect(at("appearance")).toBe(at("input_"));
			expect(at("input_")).toBeDefined();
		},
	);

	it("counts each key HQ's model removed under the removed keys' entry, and any other undeclared key under its own", async () => {
		const removed = [
			"again_label",
			"search_again_label",
			"dynamic_search",
			"command_label",
			"search_label",
			"additional_relevant",
			"search_filter",
		];
		const reading = await readLists(doc(), {
			edit: (app) => {
				const config = app.modules[0]?.search_config as Record<string, unknown>;
				for (const key of removed) config[key] = { en: "Search" };
				config.no_such_key = true;
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const entryAt = new Map(
			[...reading.ctx.close().claims.records()].map((one) => [
				one.where,
				one.entry,
			]),
		);
		for (const key of removed)
			expect(entryAt.get(`/modules/0/search_config/${key}`)).toBe(
				"case-search/removed-keys-dynamic-search-additional-relevant-search-filter",
			);
		expect(entryAt.get("/modules/0/search_config/no_such_key")).toBe(
			"case-search/any-other-unknown-casesearch-key",
		);
	});

	it.each(["username", "userid", "deviceid"])(
		"preserves %s in the shared owner exclusion",
		async (field) => {
			const workerRule = `if(instance('commcaresession')/session/context/${field} > 'm', 'a', 'b')`;
			const reading = await readLists(
				doc({ excludedOwnerIds: term(literal("abc")) }),
				{
					edit: (app) => {
						const menu = app.modules[0] as {
							case_details: { short: { filter?: unknown } };
							search_config: { blacklisted_owner_ids_expression?: unknown };
						};
						const swap = (text: unknown) =>
							typeof text === "string"
								? text.replaceAll("'abc'", workerRule)
								: text;
						menu.case_details.short.filter = swap(
							menu.case_details.short.filter,
						);
						menu.search_config.blacklisted_owner_ids_expression = swap(
							menu.search_config.blacklisted_owner_ids_expression,
						);
					},
				},
			);
			expect(closedCodes(reading)).toEqual([]);
			expect(searchOf(reading)?.excludedOwnerIds).toMatchObject({
				kind: "if",
				cond: {
					kind: "gt",
					left: {
						kind: "term",
						term: { kind: "session-context", field },
					},
				},
			});
		},
	);

	it("reads the list filter's owner clause of a refused exclusion as that refusal's, one finding", async () => {
		// An exclusion over an ordered comparison of text, which Nova's value vocabulary does not
		// hold: the search's refusal is the one cause, and the clause Nova's print would write for
		// a held exclusion is no difference of the list's.
		const outside =
			"if(instance('commcaresession')/session/context/deviceid < instance('commcaresession')/session/context/userid, 'a', 'b')";
		const reading = await readLists(
			doc({ excludedOwnerIds: term(literal("abc")) }),
			{
				edit: (app) => {
					const menu = app.modules[0] as {
						case_details: { short: { filter?: unknown } };
						search_config: { blacklisted_owner_ids_expression?: unknown };
					};
					const swap = (text: unknown) =>
						typeof text === "string" ? text.replaceAll("'abc'", outside) : text;
					menu.case_details.short.filter = swap(menu.case_details.short.filter);
					menu.search_config.blacklisted_owner_ids_expression = swap(
						menu.search_config.blacklisted_owner_ids_expression,
					);
				},
			},
		);
		expect(closedCodes(reading)).toEqual([
			"case-search/blacklisted-owner-ids-expression-outside-valueexpression",
		]);
	});

	it("reads the owner exclusion of a menu that offers no search from the list filter's clause alone", async () => {
		const filter = neq(term(prop("patient", "notes")), term(literal("none")));
		const owners = term(sessionContext("userid"));
		for (const list of [{}, { filter }]) {
			const reading = await readLists(
				patients([plainColumn(uuid(1), "case_name", "Name")], {
					search: { searchActionEnabled: false, excludedOwnerIds: owners },
					list,
				}),
			);
			expect(codes(reading)).toEqual([]);
			expect(searchOf(reading)).toEqual({
				searchActionEnabled: false,
				excludedOwnerIds: owners,
			});
			expect(listOf(reading).filter).toEqual(
				"filter" in list ? filter : undefined,
			);
		}
	});

	it("holds the whole menu's search with every setting it holds", async () => {
		const hidden: SearchInputDef = {
			uuid: uuid(10),
			kind: "hidden",
			name: "region",
			label: "Region",
			value: term(literal("north")),
		};
		const visible: SearchInputDef = {
			...field,
			hint: "Part of the notes",
			required: { message: "Say something" },
		};
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [visible, hidden],
				search: {
					searchScreenTitle: "Find a patient",
					searchScreenSubtitle: "By notes",
					// A condition on the device's day: it reads no instance, so
					// every entry showing the list can evaluate it.
					searchButtonDisplayCondition: gte(today(), dateLiteral("2026-01-01")),
					excludedOwnerIds: term(literal("abc")),
				},
			}),
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "By notes",
			searchButtonDisplayCondition: gte(today(), dateLiteral("2026-01-01")),
			excludedOwnerIds: term(literal("abc")),
		});
	});

	// HQ's build declares no instance for what only the Search action's `relevant` reads
	// (`post_process/instances.py::_get_all_xpaths_for_entry`), so a session read over a list whose
	// selection and forms read no session stops the list on the device: the reading refuses it.
	// Over a list whose filter reads the session, the same condition is held.
	it.each([
		neq(sessionContext("username"), literal("guest")),
		gt(sessionContext("username"), literal("m")),
	])(
		"requires a Search action’s worker session to be loaded by its list ($kind)",
		async (condition) => {
			const refused = await readLists(
				patients([plainColumn(uuid(1), "case_name", "Name")], {
					searchInputs: [field],
					search: { searchButtonDisplayCondition: condition },
				}),
			);
			expect(closedCodes(refused)).toContain(
				"case-search/search-button-display-condition-reading-what-the-case-list-does-not-load",
			);
			const held = await readLists(
				patients([plainColumn(uuid(1), "case_name", "Name")], {
					searchInputs: [field],
					list: {
						filter: eq(
							term(prop("patient", "owner_id")),
							term(sessionContext("userid")),
						),
					},
					search: { searchButtonDisplayCondition: condition },
				}),
			);
			expect(codes(held)).toEqual([]);
			expect(searchOf(held)).toMatchObject({
				searchButtonDisplayCondition: condition,
			});
		},
	);

	// HQ's page keeps the text an author types, so a session value Nova reads inside its guard
	// (`if(count(P) > 0, P, '')`, `absent-session-value-guard`) may be read bare. The expression
	// stage holds the slot with the rewrite withheld, and the settle prints the whole search with
	// each slot at the level it was held at (`settings.ts::heldSearchLevels`), so the setting is
	// held and the rewrite recorded. The failure it catches: a settle that compares the stored
	// search with the print that applies every rewrite, refusing a setting its slot held; and the
	// owner list printed with no rewrite control, so no level prints it and the reading ends in a
	// reader defect.
	it.each([
		[
			"search_button_display_condition",
			"schema:CaseSearch.search_button_display_condition",
		],
		[
			"blacklisted_owner_ids_expression",
			"schema:CaseSearch.blacklisted_owner_ids_expression",
		],
	] as const)(
		"holds a %s that reads a session value bare, and records the rewrite",
		async (key, surfaceKey) => {
			const language =
				"instance('commcaresession')/session/context/applanguage";
			const guarded = `if(count(${language}) > 0, ${language}, '')`;
			const reading = await readLists(
				doc({
					searchButtonDisplayCondition: eq(
						term(sessionContext("applanguage")),
						literal("en"),
					),
					excludedOwnerIds: concat(
						term(literal("abc ")),
						term(sessionContext("applanguage")),
					),
				}),
				{
					edit: (app) => {
						const config = app.modules[0]?.search_config as Record<
							string,
							unknown
						>;
						const stored = String(config[key]);
						expect(stored).toContain(guarded);
						config[key] = stored.split(guarded).join(language);
					},
				},
			);
			expect(closedCodes(reading)).toEqual([]);
			expect(reading.ctx.close().defects).toEqual([]);
			expect(
				reading.ctx.facts.rewrites.map((one) => [one.id, one.key]),
			).toEqual([["absent-session-value-guard", surfaceKey]]);
		},
	);

	it("derives `include_all_related_cases` where no field reads a related case", async () => {
		const reading = await readLists(doc());
		expect(codes(reading)).toEqual([]);
	});

	it("keeps an explicit hierarchy where no field reads a related case", async () => {
		const reading = await readLists(doc(), {
			edit: (app) => {
				const config = app.modules[0]?.search_config;
				if (config !== undefined) config.include_all_related_cases = true;
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({ relatedRecords: "hierarchy" });
	});

	it.each(["patients", "Client_Étage2"])(
		"keeps the editor-safe search name %s",
		async (name) => {
			const reading = await readLists(doc(), {
				edit: (app) => {
					app.modules[0].search_config.instance_name = name;
				},
			});
			expect(codes(reading)).toEqual([]);
			expect(reading.ctx.draft.modules[0]?.module.searchResultsName).toBe(name);
		},
	);

	it.each([
		[
			"my_casedb",
			"case-search/instance-name-containing-casedb-ledgerdb-fixture-or-session",
		],
		["3patients", "case-search/results-name-outside-the-search-editor"],
		["bad-name", "case-search/results-name-outside-the-search-editor"],
	])("identifies why the name %s cannot be brought in", async (name, entry) => {
		const reading = await readLists(doc(), {
			edit: (app) => {
				app.modules[0].search_config.instance_name = name;
			},
			firstPassOnly: true,
		});
		expect(codes(reading)).toContain(entry);
	});

	/** Two searching menus of patients, the second under the first, each with its own field. */
	function twoMenus() {
		const menu = (name: string, n: number) => ({
			name,
			caseType: "patient",
			forms: [
				{
					name: `${name} visit`,
					type: "followup" as const,
					fields: [
						f({
							kind: "text",
							id: "notes",
							caseWrite: { caseType: "patient", property: "notes" },
						}),
					],
				},
			],
			caseListConfig: {
				columns: [plainColumn(uuid(n), "case_name", "Name")],
				searchInputs: [{ ...field, uuid: uuid(n + 1) }],
			},
		});
		const first = menu("Patients", 20);
		return buildDoc({
			modules: [
				{
					...first,
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
						...first.forms,
					],
				},
				menu("Visits", 30),
			],
		});
	}

	/** The second menu names the first: as its root menu, or as its parent selection. */
	const links: [string, (app: AppJson) => void][] = [
		[
			"its root menu",
			(app) => {
				const [first, second] = app.modules;
				if (first !== undefined && second !== undefined)
					second.root_module_id = first.unique_id;
			},
		],
		[
			"the menu its parent selection names",
			(app) => {
				const [first, second] = app.modules;
				if (first !== undefined && second !== undefined)
					second.parent_select = {
						active: true,
						module_id: first.unique_id,
						relationship: "parent",
					};
			},
		],
	];
	const clash =
		"case-search/a-module-whose-effective-results-instance-results-instance-name";
	const inert =
		"case-search/an-effective-results-instance-equal-to-a-module-s-that-does-not";

	/** The first menu's search made inline: it searches as its forms open. */
	const inline = (app: AppJson) => {
		const config = app.modules[0]?.search_config;
		if (config !== undefined) {
			config.inline_search = true;
			config.auto_launch = true;
		}
	};
	const named = (app: AppJson, name: string) => {
		for (const module of app.modules) module.search_config.instance_name = name;
	};

	/** The one finding of each link's clash: a parent selection's is the menus' refusal of the
	 *  selection at the menu, which names it (`menus/modules.ts`), and the root menu's is the
	 *  search's. */
	const clashOf = (how: string) =>
		how === "its root menu"
			? clash
			: "menus-and-case-lists/parent-select-naming-a-module-that-searches-inline-under-the";

	for (const [how, link] of links) {
		it(`raises a results instance equal to the inline search of ${how}, with no name`, async () => {
			const reading = await readLists(twoMenus(), {
				edit: (app) => {
					link(app);
					inline(app);
				},
				firstPassOnly: true,
			});
			expect(reading.findings.map((one) => one.code)).toContain(clashOf(how));
			expect(codes(reading).filter((code) => code === clash).length).toBe(
				clashOf(how) === clash ? 1 : 0,
			);
		});

		it(`raises a named results instance equal to the inline search of ${how}`, async () => {
			const reading = await readLists(twoMenus(), {
				edit: (app) => {
					link(app);
					inline(app);
					named(app, "found");
				},
				firstPassOnly: true,
			});
			expect(reading.findings.map((one) => one.code)).toContain(clashOf(how));
			expect(codes(reading).filter((code) => code === clash).length).toBe(
				clashOf(how) === clash ? 1 : 0,
			);
		});

		it(`raises the clash with ${how} on a menu that offers no search`, async () => {
			const reading = await readLists(twoMenus(), {
				edit: (app) => {
					link(app);
					inline(app);
					const config = app.modules[1]?.search_config;
					if (config !== undefined) {
						config.properties = [];
						config.default_properties = [];
					}
				},
				firstPassOnly: true,
			});
			expect(reading.findings.map((one) => one.code)).toContain(clashOf(how));
			expect(codes(reading).filter((code) => code === clash).length).toBe(
				clashOf(how) === clash ? 1 : 0,
			);
		});

		it(`claims a named results instance equal to the search of ${how} that is not inline, and raises nothing for it`, async () => {
			const reading = await readLists(twoMenus(), {
				edit: (app) => {
					link(app);
					named(app, "found");
				},
				firstPassOnly: true,
			});
			// The first menu's name clashes with no menu, so its own row refuses it; the second's
			// equals the first's, whose search is not inline.
			const second = reading.ctx
				.close()
				.findings.filter(
					(one) => one.place.kind === "search" && one.place.menu === 1,
				)
				.map((one) =>
					one.code === "unrecognized"
						? `unrecognized:${(one.detail as { name?: string }).name ?? ""}`
						: one.code,
				);
			expect(second).not.toContain(clash);
			expect(second).not.toContain(inert);
			expect(second).not.toContain(
				"case-search/instance-name-without-casedb-ledgerdb-fixture-or-session-in-it",
			);
			expect(second).not.toContain(
				"unrecognized:schema:CaseSearch.instance_name",
			);
			expect(codes(reading)).not.toContain(
				"case-search/instance-name-without-casedb-ledgerdb-fixture-or-session-in-it",
			);
		});
	}

	for (const src of [
		"jr://instance/remote/results:visits",
		"jr://instance/search-input/results:visits",
	])
		it(`reads a form's read of a results instance under a refused name as that refusal's (${src})`, async () => {
			const id = src.includes("search-input")
				? "search-input:results:visits"
				: "results:visits";
			const reading = await readLists(twoMenus(), {
				edit: (app) => {
					inline(app);
					app.modules[0].search_config.instance_name = "visits";
					const attachments = app._attachments as Record<string, string>;
					const [name] = Object.keys(attachments).filter((key) =>
						(attachments[key] as string).includes('nodeset="/data/notes"'),
					);
					if (name === undefined) throw new Error("The menu holds a visit.");
					let xml = attachments[name] as string;
					const declared = xml.indexOf("</instance>") + "</instance>".length;
					xml = `${xml.slice(0, declared)}<instance id="${id}" src="${src}"/>${xml.slice(declared)}`;
					xml = xml.replace("<notes/>", "<notes/><seen/>");
					xml = xml.replace(
						"</model>",
						`<bind nodeset="/data/seen" calculate="instance('${id}')/results/case[1]/case_name"/></model>`,
					);
					attachments[name] = xml;
				},
			});
			const all = reading.ctx
				.close()
				.findings.map((one) =>
					one.code === "unrecognized"
						? `unrecognized:${(one.detail as { name?: string }).name ?? ""}`
						: one.code,
				);
			expect(all).not.toContain(
				"case-search/instance-name-without-casedb-ledgerdb-fixture-or-session-in-it",
			);
			expect(all).not.toContain(
				"expressions-and-data/declared-and-referenced-instance-with-an-unrecognized-src",
			);
		});
});

describe("a search's default filters", () => {
	it("reads HQ's two markers alone as Nova's search with no fields and no filter, and records the rewrite", async () => {
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [],
				search: {},
			}),
			{
				edit: (app) => {
					const config = app.modules[0]?.search_config;
					if (config !== undefined)
						config.default_properties = [
							{
								doc_type: "DefaultCaseSearchProperty",
								property: "include_closed",
								defaultValue: "False",
							},
						];
				},
			},
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toBeDefined();
		expect(
			reading.ctx.facts.sameStateRewrites.map((one) => one.register),
		).toContain("search-filter-rows-recut");
	});

	/** The patients' search with one more default filter, keyed and valued as given, and the
	 *  search's related-case property where one is given. */
	const keyed = (property: string, defaultValue: string, related?: string) =>
		readLists(doc(), {
			edit: (app) => {
				const config = app.modules[0]?.search_config;
				if (config === undefined) return;
				const rows = Array.isArray(config.default_properties)
					? config.default_properties
					: [];
				config.default_properties = [
					...rows,
					{ doc_type: "DefaultCaseSearchProperty", property, defaultValue },
				];
				if (related !== undefined)
					config.custom_related_case_property = related;
			},
			firstPassOnly: true,
		});
	const runtime =
		"case-search/a-commcare-sort-x-commcare-custom-related-case-property-or-case";
	const sortKey =
		"case-search/default-properties-entry-keyed-commcare-sort-x-commcare-custom";
	const typeKey = "case-search/default-properties-entry-keyed-case-type";

	for (const key of [
		"commcare_sort",
		"x_commcare_custom_related_case_property",
		"case_type",
	])
		it(`raises a \`${key}\` filter whose value is computed at runtime by its refusal, not by the key's own row`, async () => {
			const reading = await keyed(
				key,
				"instance('commcaresession')/session/data/choice",
			);
			expect(codes(reading)).toContain(runtime);
			expect(codes(reading)).not.toContain(sortKey);
			expect(codes(reading)).not.toContain(typeKey);
		});

	it("holds a literal sort Nova reads, and raises one it does not and a literal case type by their own rows", async () => {
		const held = await keyed("commcare_sort", "'+name'");
		expect(codes(held)).not.toContain(sortKey);
		expect(codes(held)).not.toContain(runtime);
		const sort = await keyed("commcare_sort", "'+name:fuzzy'");
		expect(codes(sort)).toContain(sortKey);
		expect(codes(sort)).not.toContain(runtime);
		const type = await keyed("case_type", "'patient'");
		expect(listOf(type).searchFilters).toMatchObject([
			{ kind: "request-record-type", caseType: "patient" },
		]);
		expect(codes(type)).not.toContain(runtime);
	});

	it("raises the related-case property arriving both as a filter and as the search's own setting", async () => {
		const reading = await keyed(
			"x_commcare_custom_related_case_property",
			"'parent/name'",
			"name",
		);
		expect(closedCodes(reading)).toEqual([
			"case-search/an-x-commcare-custom-related-case-property-entry-together-with",
		]);
	});
});

it("keeps a Search button condition that counts the worker's restored cases", async () => {
	const authored =
		"count(instance('casedb')/casedb/case[@case_type = 'patient']) > 1";
	const reading = await readLists(doc(), {
		edit: (app) => {
			app.modules[0].search_config.search_button_display_condition = authored;
		},
	});
	expect(closedCodes(reading), JSON.stringify(reading.findings)).toEqual([]);
	expect(searchOf(reading)).toMatchObject({
		searchButtonDisplayCondition: {
			kind: "gt",
			left: { kind: "count", via: { kind: "cases", source: "casedb" } },
			right: { kind: "term", term: { kind: "literal", value: 1 } },
		},
	});
});
