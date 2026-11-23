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
	eq,
	input,
	literal,
	neq,
	prop,
	sessionContext,
	term,
} from "@/lib/domain/expression/builders";
import { NO_SEARCH_SCREEN_TITLE, plainColumn } from "@/lib/domain/modules";
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

	it("raises a title shown blank in the source language beside another's text", async () => {
		// A language with no title of its own shows the first language's, so a blank first
		// language, here the source, shows blank beside another's text. The refusal stands alone:
		// the search's rows, which the settle never reaches, stand under it.
		const reading = await readLists(doc({ searchScreenTitle: "Find" }), {
			edit: (app) => {
				(app as Record<string, unknown>).langs = ["en", "fra"];
				const config = app.modules[0]?.search_config;
				if (config !== undefined)
					config.title_label = { en: "", fra: "Trouver" };
			},
		});
		expect(closedCodes(reading)).toEqual([
			"case-search/title-label-blank-in-some-languages",
		]);
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

	it("refuses a stored owner exclusion the list filter holds no clause for, where Nova's list would", async () => {
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
		expect(closedCodes(reading)).toEqual([
			"case-search/blacklisted-owner-ids-expression-without-that-clause",
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

	it("reads the list filter's owner clause of a refused exclusion as that refusal's, one finding", async () => {
		// An exclusion over an ordered comparison of text, which Nova's value vocabulary does not
		// hold: the search's refusal is the one cause, and the clause Nova's print would write for
		// a held exclusion is no difference of the list's.
		const outside =
			"if(instance('commcaresession')/session/context/username > 'm', 'a', 'b')";
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
					searchButtonDisplayCondition: neq(
						sessionContext("username"),
						literal("guest"),
					),
					excludedOwnerIds: term(literal("abc")),
				},
			}),
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "By notes",
			searchButtonDisplayCondition: neq(
				sessionContext("username"),
				literal("guest"),
			),
			excludedOwnerIds: term(literal("abc")),
		});
	});

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

	it("raises `include_all_related_cases` stored where no field reads a related case", async () => {
		const reading = await readLists(doc(), {
			edit: (app) => {
				const config = app.modules[0]?.search_config;
				if (config !== undefined) config.include_all_related_cases = true;
			},
		});
		expect(codes(reading)).toContain(
			"case-search/include-all-related-cases-authored-without-relation-reads",
		);
	});

	const instances: [string, string][] = [
		[
			"patients",
			"case-search/instance-name-without-casedb-ledgerdb-fixture-or-session-in-it",
		],
		[
			"my_casedb",
			"case-search/instance-name-containing-casedb-ledgerdb-fixture-or-session",
		],
	];
	for (const [name, entry] of instances)
		it(`raises the results instance \`${name}\` by its row`, async () => {
			const reading = await readLists(doc(), {
				edit: (app) => {
					const config = app.modules[0]?.search_config;
					if (config !== undefined) config.instance_name = name;
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
			expect(codes(reading)).toContain(
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
			expect(all).toContain(
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

	it("raises a literal sort key and a literal case type by their own rows", async () => {
		const sort = await keyed("commcare_sort", "'+name'");
		expect(codes(sort)).toContain(sortKey);
		expect(codes(sort)).not.toContain(runtime);
		const type = await keyed("case_type", "'patient'");
		expect(codes(type)).toContain(typeKey);
		expect(codes(type)).not.toContain(runtime);
	});

	it("raises the related-case property arriving both as a filter and as the search's own setting", async () => {
		const reading = await keyed(
			"x_commcare_custom_related_case_property",
			"'parent/name'",
			"name",
		);
		expect(codes(reading)).toContain(
			"case-search/an-x-commcare-custom-related-case-property-entry-together-with",
		);
		expect(codes(reading)).not.toContain(sortKey);
	});
});
