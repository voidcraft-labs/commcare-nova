/**
 * Contract: a search as CommCare HQ's own pages save it, and as its build reads it, reads into
 * the document whose export HQ builds the same, or into the finding that names what keeps it
 * out, at the search. Each case starts from Nova's export of a document built with production
 * builders and edits the JSON the way HQ's Case List page, an import or a copy leaves it:
 *
 * - a blank `""` in a key HQ reads only where it holds text (five search keys and a prompt's
 *   `receiver_expression` and `default_value`, which the Case List page writes on every save),
 *   and a `required` whose test is blank, are the key absent, and so are the registry's
 *   workflow and extra cases where no registry is named;
 * - `additional_case_types` naming another type is refused on a menu that offers no search as on
 *   one that does, since HQ's build widens the menu's own list by it, and naming only the menu's
 *   own type is the key absent;
 * - a prompt without `exclude` whose name Nova's property grammar refuses, or that HQ reads as
 *   the case's name, is a finding at the search, never a document the schema refuses;
 * - Nova's zero-input row beside a list filter is the filter's clauses left unrestated;
 * - a search on a menu that shows its forms above is a finding whatever its three booleans hold;
 * - a row held up to a rewrite reports the rewrite in the reading; a row that splices the device's
 *   day between its own quote marks is Nova's row, with no rewrite; and a field a row matches with
 *   neither Nova's quote checks nor its check of the answer's quotes is the field Nova's first
 *   publish sends with both, under the one rewrite `search-value-guards`;
 * - a text a map holds in only some app languages reads as the build shows it in each, the search
 *   title by its own rule (a language with none of its own shows the first language's);
 * - a check whose message is blank in every language is a finding at the search.
 *
 * The failure it catches: a correct HQ app refused for a feature it does not use; an app read
 * silently into a document whose first publish searches differently; a reading that ends in a
 * reader defect at assembly instead of a finding at the search.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import type { BlueprintDoc, SearchInputDef } from "@/lib/domain";
import {
	eq,
	input,
	literal,
	lte,
	neq,
	prop,
	today,
	whenInput,
} from "@/lib/domain/expression/builders";
import { plainColumn } from "@/lib/domain/modules";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	type AppJson,
	closedCodes,
	codes,
	listOf,
	readLists,
	searchOf,
} from "../../caseList/__tests__/listReading";
import { csqlRow } from "../../expressions/__tests__/csqlVectors";

const NOTES: SearchInputDef = {
	uuid: uuid(9),
	name: "notes",
	label: "Notes",
	kind: "simple",
	type: "text",
	property: "notes",
};

const COLUMNS = [plainColumn(uuid(1), "case_name", "Name")];

function searchConfig(app: AppJson, module = 0): Record<string, unknown> {
	return app.modules[module]?.search_config as Record<string, unknown>;
}

function prompt(app: AppJson, index = 0): Record<string, unknown> {
	return (searchConfig(app).properties as Record<string, unknown>[])[
		index
	] as Record<string, unknown>;
}

function registers(reading: Awaited<ReturnType<typeof readLists>>): string[] {
	return reading.ctx.facts.sameStateRewrites.map((one) => one.register);
}

describe("the blanks HQ's Case List page writes", () => {
	it("reads every blank key a save writes as the key absent", async () => {
		const reading = await readLists(
			patients(COLUMNS, { searchInputs: [NOTES] }),
			{
				edit: (app) => {
					Object.assign(searchConfig(app), {
						search_button_display_condition: "",
						blacklisted_owner_ids_expression: "",
						data_registry: "",
						data_registry_workflow: "",
						custom_related_case_property: "",
						instance_name: "",
					});
					Object.assign(prompt(app), {
						receiver_expression: "",
						default_value: "",
					});
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).searchInputs).toHaveLength(1);
		expect(listOf(reading).searchInputs[0]).toMatchObject({
			kind: "simple",
			name: "notes",
			property: "notes",
		});
		expect(listOf(reading).searchInputs[0]).not.toHaveProperty("default");
		expect(registers(reading)).toContain("list-settings-respelled");
	});

	it("reads a blank owner list on a menu that offers no search as none", async () => {
		const reading = await readLists(patients(COLUMNS), {
			edit: (app) => {
				searchConfig(app).blacklisted_owner_ids_expression = "";
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(searchOf(reading)).toBeUndefined();
	});

	it("reads a requirement whose test is blank as none, whatever its text", async () => {
		const reading = await readLists(
			patients(COLUMNS, { searchInputs: [NOTES] }),
			{
				edit: (app) => {
					prompt(app).required = {
						doc_type: "Assertion",
						test: null,
						text: { en: "Needed" },
					};
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).searchInputs[0]).not.toHaveProperty("required");
		expect(registers(reading)).toContain("list-settings-respelled");
	});

	it("reads the workflow a save leaves beside a blank registry as nothing", async () => {
		// On a project space with the data registry, the Case List page's hidden workflow
		// `<select>` sets the model to its first option on every save.
		const reading = await readLists(
			patients(COLUMNS, { searchInputs: [NOTES] }),
			{
				edit: (app) => {
					Object.assign(searchConfig(app), {
						data_registry: "",
						data_registry_workflow: "load_case",
						additional_registry_cases: [],
					});
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).searchInputs).toHaveLength(1);
		expect(registers(reading)).toContain("list-settings-respelled");
	});

	it("reads extra registry cases where no registry is named as nothing", async () => {
		const reading = await readLists(
			patients(COLUMNS, { searchInputs: [NOTES] }),
			{
				edit: (app) => {
					Object.assign(searchConfig(app), {
						data_registry_workflow: "smart_link",
						additional_registry_cases: [
							"instance('commcaresession')/session/data/case_id",
						],
					});
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
	});

	it("still refuses a registry that names one", async () => {
		const reading = await readLists(
			patients(COLUMNS, { searchInputs: [NOTES] }),
			{
				edit: (app) => {
					searchConfig(app).data_registry = "regional";
				},
				firstPassOnly: true,
			},
		);
		expect(codes(reading)).toContain(
			"case-search/data-registry-data-registry-workflow-additional-registry-cases",
		);
	});
});

describe("additional case types", () => {
	it("are refused on a menu that offers no search, whose list they widen", async () => {
		const reading = await readLists(patients(COLUMNS), {
			edit: (app) => {
				searchConfig(app).additional_case_types = ["household"];
			},
			firstPassOnly: true,
		});
		expect(codes(reading)).toContain("case-search/additional-case-types");
	});

	it("are refused on a menu that searches", async () => {
		const reading = await readLists(
			patients(COLUMNS, { searchInputs: [NOTES] }),
			{
				edit: (app) => {
					searchConfig(app).additional_case_types = ["household"];
				},
				firstPassOnly: true,
			},
		);
		expect(codes(reading)).toContain("case-search/additional-case-types");
	});

	it("are refused where they name the menu's own type beside another", async () => {
		const reading = await readLists(patients(COLUMNS), {
			edit: (app) => {
				searchConfig(app).additional_case_types = ["patient", "household"];
			},
			firstPassOnly: true,
		});
		expect(codes(reading)).toContain("case-search/additional-case-types");
	});

	it.each([
		["a menu that offers no search", false, ["patient"]],
		["a menu that searches", true, ["patient", "patient"]],
	])(
		"naming only the menu's own type widen nothing, on %s",
		async (_, searches, types) => {
			const reading = await readLists(
				patients(COLUMNS, searches ? { searchInputs: [NOTES] } : {}),
				{
					edit: (app) => {
						searchConfig(app).additional_case_types = types;
					},
				},
			);
			expect(closedCodes(reading)).toEqual([]);
			expect(listOf(reading).searchInputs ?? []).toHaveLength(searches ? 1 : 0);
		},
	);
});

describe("a bare prompt's name", () => {
	it.each([
		["_x", "case-search/prompt-key-outside-nova-s-name-grammar"],
		["date-opened", "case-search/prompt-key-outside-nova-s-name-grammar"],
		["external-id", "case-search/prompt-key-outside-nova-s-name-grammar"],
	])(
		"%s is a finding at the search, not a property no document holds",
		async (name, code) => {
			const reading = await readLists(
				patients(COLUMNS, { searchInputs: [NOTES] }),
				{
					edit: (app) => {
						prompt(app).name = name;
					},
				},
			);
			expect(codes(reading)).toContain(code);
			expect(
				reading.ctx.draft.caseTypes
					?.find((type) => type.name === "patient")
					?.properties.map((one) => one.name),
			).not.toContain(name);
		},
	);
});

describe("Nova's zero-input row beside a list filter", () => {
	it("holds the list's filter apart from a search that sends every case", async () => {
		const reading = await readLists(
			patients(COLUMNS, {
				search: {},
				list: { filter: eq(prop("patient", "notes"), literal("open")) },
			}),
			{
				edit: (app) => {
					searchConfig(app).default_properties = [
						{
							doc_type: "DefaultCaseSearchProperty",
							property: "_xpath_query",
							defaultValue: csqlRow("match-all()"),
						},
					];
				},
			},
		);
		expect(codes(reading)).toEqual([]);
		expect(listOf(reading)).toMatchObject({
			filter: eq(prop("patient", "notes"), literal("open")),
			searchCondition: { kind: "match-all" },
		});
	});
});

describe("a search on a menu that shows its forms above", () => {
	it("is a finding when it shows the list first, every boolean at its default", async () => {
		const reading = await readLists(
			patients(COLUMNS, { searchInputs: [NOTES] }),
			{
				edit: (app) => {
					(app.modules[0] as Record<string, unknown>).put_in_root = true;
					Object.assign(searchConfig(app), {
						auto_launch: false,
						default_search: false,
						inline_search: false,
					});
				},
				firstPassOnly: true,
			},
		);
		expect(codes(reading)).toContain(
			"case-search/search-on-a-put-in-root-module",
		);
	});
});

describe("a search row on the project space's day beside a list on the worker's", () => {
	it("holds the two days apart, with no rewrite", async () => {
		const reading = await readLists(
			patients(COLUMNS, {
				searchInputs: [NOTES],
				list: { filter: lte(prop("patient", "dob"), today()) },
			}),
			{
				edit: (app) => {
					const rows = searchConfig(app).default_properties as Record<
						string,
						unknown
					>[];
					const row = rows.find((one) => one.property === "_xpath_query");
					if (row === undefined) throw new Error("No _xpath_query row.");
					row.defaultValue = csqlRow("dob <= today()");
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		expect(reading.ctx.facts.rewrites).toEqual([]);
		expect(listOf(reading)).toMatchObject({
			filter: lte(prop("patient", "dob"), today()),
			searchCondition: {
				kind: "lte",
				right: { kind: "today", clock: "project-space" },
			},
		});
	});
});

describe("a row an author wrote around the device's values", () => {
	it("holds the device's day between other quote marks than Nova's, with no rewrite", async () => {
		const filter = lte(prop("patient", "dob"), today());
		const reading = await readLists(
			patients(COLUMNS, { searchInputs: [NOTES], list: { filter } }),
			{
				edit: (app) => {
					const rows = searchConfig(app).default_properties as Record<
						string,
						unknown
					>[];
					expect(rows).toHaveLength(1);
					(rows[0] as Record<string, unknown>).defaultValue =
						`concat("dob <= '", today(), "'")`;
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).filter).toEqual(filter);
		expect(reading.ctx.facts.rewrites).toEqual([]);
	});

	it("holds a field matched with neither Nova's quote checks nor its check, under the guards' rewrite", async () => {
		const answer =
			"instance('search-input:results')/input/field[@name = 'phone']";
		const phone: SearchInputDef = {
			uuid: uuid(10),
			name: "phone",
			label: "Phone",
			kind: "advanced",
			type: "text",
			predicate: whenInput(
				input(uuid(10)),
				eq(prop("patient", "phone"), input(uuid(10))),
			),
		};
		const reading = await readLists(
			patients(COLUMNS, { searchInputs: [NOTES, phone], search: {} }),
			{
				edit: (app) => {
					const rows = searchConfig(app).default_properties as Record<
						string,
						unknown
					>[];
					expect(rows).toHaveLength(1);
					(rows[0] as Record<string, unknown>).defaultValue =
						`if(count(${answer}), concat("phone = '", ${answer}, "'"), 'match-all()')`;
					// Nova's export checks the answer's quotes on the field; the author's field has no check.
					expect(prompt(app, 1).validations).toHaveLength(1);
					prompt(app, 1).validations = [];
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		// The reading mints the field's uuid, so its condition is compared by its shape.
		const read = listOf(reading).searchInputs.find(
			(one) => one.name === "phone",
		);
		expect(read).toMatchObject({
			kind: "advanced",
			predicate: { kind: "when-input-present" },
		});
		expect(read).not.toHaveProperty("validation");
		// The row's guards and the check the field gains are each the guards' rewrite, where each is stored.
		expect(reading.ctx.facts.rewrites.map((one) => [one.id, one.key])).toEqual([
			["search-value-guards", "schema:DefaultCaseSearchProperty.defaultValue"],
			["search-value-guards", "schema:CaseSearchProperty.validations"],
		]);
	});
});

/** `doc` in English and Spanish, with no translation of its own. */
function bilingual(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		draft.localization = {
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa"],
			wireCodes: { eng: "en", spa: "es" },
			translations: { spa: {} },
		};
	});
}

describe("a text held in only some app languages", () => {
	it("reads as the build shows it in each, with no translation", async () => {
		const field: SearchInputDef = {
			...NOTES,
			hint: "Any part of them",
			required: { message: "Fill in the notes" },
		};
		const reading = await readLists(
			bilingual(
				patients(COLUMNS, {
					searchInputs: [field],
					search: { searchScreenSubtitle: "By notes" },
				}),
			),
			{
				edit: (app) => {
					(app as Record<string, unknown>).langs = ["en", "es"];
					searchConfig(app).description = { en: "By notes" };
					const one = prompt(app);
					one.label = { en: "Notes" };
					one.hint = { en: "Any part of them" };
					(one.required as Record<string, unknown>).text = {
						en: "Fill in the notes",
					};
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).searchInputs[0]).toMatchObject({
			label: "Notes",
			hint: "Any part of them",
			required: { message: "Fill in the notes" },
		});
		expect(searchOf(reading)).toMatchObject({
			searchScreenSubtitle: "By notes",
		});
		expect(registers(reading)).toContain("list-settings-respelled");
	});

	it("reads a text held only in another language as that text", async () => {
		const reading = await readLists(
			bilingual(patients(COLUMNS, { searchInputs: [NOTES] })),
			{
				edit: (app) => {
					(app as Record<string, unknown>).langs = ["en", "es"];
					prompt(app).label = { es: "Notas" };
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).searchInputs[0]).toMatchObject({ label: "Notas" });
	});
});

describe("a search title held in only some app languages", () => {
	const titled = () =>
		bilingual(
			patients(COLUMNS, {
				searchInputs: [NOTES],
				search: { searchScreenTitle: "Find patients" },
			}),
		);

	it.each([
		["lacks", { en: "Find patients" }],
		["holds blank", { en: "Find patients", es: "" }],
	])(
		"shows the first language's where another language %s it",
		async (_, title) => {
			const reading = await readLists(titled(), {
				edit: (app) => {
					(app as Record<string, unknown>).langs = ["en", "es"];
					searchConfig(app).title_label = title;
				},
			});
			expect(closedCodes(reading)).toEqual([]);
			expect(searchOf(reading)).toMatchObject({
				searchScreenTitle: "Find patients",
			});
			expect(registers(reading)).toContain("list-settings-respelled");
		},
	);

	// A language whose own title is only spaces holds it in its own table, which a device shows
	// blank (`app_strings.py::create_custom_app_strings` keeps a title Python reads as text, and
	// `commcare_translations.py::dumps` writes it blank). The title is held as every app string
	// is (`heldText.ts::heldText`): that language takes the source's title, which a worker there
	// then reads, so the reading records `text-spaces-dropped`.
	it("holds a title only spaces in another language as the source's, and records the change", async () => {
		const reading = await readLists(titled(), {
			edit: (app) => {
				(app as Record<string, unknown>).langs = ["en", "es"];
				searchConfig(app).title_label = { en: "Find patients", es: "  " };
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			searchScreenTitle: "Find patients",
		});
		expect(registers(reading)).toContain("text-spaces-dropped");
	});

	// The default table holds the first language's title (`get_search_title_label` reads
	// `app.default_language`, `langs[0]`, for it), so where that title is blank every language
	// with none of its own shows blank. Where the reading's source is another language, which the
	// app's name tells, that language holds the title and the first takes it.
	it("holds a title blank in the first language where the source holds text", async () => {
		const reading = await readLists(titled(), {
			edit: (app) => {
				const root = app as Record<string, unknown>;
				root.langs = ["es", "en"];
				const translations = (root.translations ?? {}) as Record<
					string,
					Record<string, string>
				>;
				translations.es = {
					...translations.es,
					"app.display.name": "Pacientes",
				};
				root.translations = translations;
				searchConfig(app).title_label = { es: "", en: "Find patients" };
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			searchScreenTitle: "Find patients",
		});
		expect(registers(reading)).toContain("text-spaces-dropped");
	});

	// The source language's title is the document's slot, which holds text or no title in every
	// language, so a title the source shows blank beside another's text has no document. The
	// refusal is the only finding: the search's rows, which the settle never reaches, stand under it.
	it("is a finding where the source's is blank and another's is not", async () => {
		const status: SearchInputDef = {
			uuid: uuid(10),
			name: "status",
			label: "Status",
			kind: "advanced",
			type: "text",
			predicate: whenInput(
				input(uuid(10)),
				eq(prop("patient", "status"), input(uuid(10))),
			),
		};
		const reading = await readLists(
			bilingual(
				patients(COLUMNS, {
					searchInputs: [NOTES, status],
					search: { searchScreenTitle: "Find patients" },
				}),
			),
			{
				edit: (app) => {
					(app as Record<string, unknown>).langs = ["en", "es"];
					searchConfig(app).title_label = { en: "", es: "Buscar" };
					// The advanced field's condition is a row of the search's default filters.
					expect(searchConfig(app).default_properties).toHaveLength(1);
				},
			},
		);
		expect(closedCodes(reading)).toEqual([
			"case-search/title-label-blank-in-some-languages",
		]);
	});
});

describe("a check with no message in any language", () => {
	it("is a finding at the search for a requirement", async () => {
		const reading = await readLists(
			patients(COLUMNS, {
				searchInputs: [{ ...NOTES, required: { message: "Fill it in" } }],
			}),
			{
				edit: (app) => {
					(prompt(app).required as Record<string, unknown>).text = {};
				},
			},
		);
		expect(codes(reading)).toContain(
			"case-search/a-required-or-validation-test-with-no-message-in-any-language",
		);
		// The field stays in the provisional document, with no requirement and no property, so an
		// expression that reads it binds (`prompts.ts::readPrompt`).
		expect(
			listOf(reading).searchInputs.map((one) => ({
				name: one.name,
				kind: one.kind,
				required: "required" in one ? one.required : undefined,
			})),
		).toEqual([{ name: "notes", kind: "advanced", required: undefined }]);
	});

	it("is a finding at the search for a validation", async () => {
		const reading = await readLists(
			patients(COLUMNS, {
				searchInputs: [
					{
						...NOTES,
						validation: {
							rule: neq(input(NOTES.uuid), literal("none")),
							message: "Only x",
						},
					},
				],
			}),
			{
				edit: (app) => {
					const validations = prompt(app).validations as Record<
						string,
						unknown
					>[];
					for (const one of validations) one.text = { en: "" };
				},
			},
		);
		expect(codes(reading)).toContain(
			"case-search/a-required-or-validation-test-with-no-message-in-any-language",
		);
	});

	it("is no finding where the message is Nova's own sentence", async () => {
		const reading = await readLists(
			patients(COLUMNS, { searchInputs: [{ ...NOTES, required: {} }] }),
		);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).searchInputs[0]).toMatchObject({ required: {} });
	});
});
