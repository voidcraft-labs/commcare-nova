/**
 * Contract: a Search field CommCare HQ holds that Nova cannot hold is one finding, its own, at the
 * search, for each cause it holds, and nothing else the search holds is a finding for it: the
 * prompt's other keys are read, or stand under that finding, and the field stays in the
 * provisional document, so the other fields' tests that read it bind (`prompts.ts::readPrompt`).
 *
 * The failure it catches: a refusal that drops the whole prompt, so the close names each of its
 * other keys `unrecognized` beside the true finding, and a sibling's required test that reads the
 * field is refused under `case-search/required-or-validation-test-outside-what-nova-types` for a
 * field the reading left out. Each case reads Nova's own export of three Search fields, the second
 * of which is required where the first is blank, with one prompt edited as CommCare HQ stores it,
 * and holds the reading's whole account.
 */
import { describe, expect, it } from "vitest";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { runValidation } from "../../../validator/runner";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
import type { ReaderInput } from "../../types";

type ReaderInputOf = ReaderInput;

const PROMPTS = localizationWireFixture("prompts");
const S = "case-search/";

type JsonObject = Record<string, unknown>;

/** The prompts of the export's one search, as HQ stores them. */
function promptsOf(body: JsonObject): JsonObject[] {
	const modules = body.modules as JsonObject[];
	const config = modules[0]?.search_config as JsonObject;
	return config.properties as JsonObject[];
}

/** The first prompt, `case_name`, which the second prompt's required test reads, renamed in both. */
function renameFirst(body: JsonObject, name: string): void {
	const [first, second] = promptsOf(body);
	if (first === undefined || second === undefined)
		throw new Error("The prompts fixture holds three Search fields.");
	first.name = name;
	const required = second.required as JsonObject;
	const test = required.test as string;
	const read = "[@name = 'case_name']";
	expect(test).toContain(read);
	required.test = test.split(read).join(`[@name = '${name}']`);
}

const itemset = (instance: string, nodeset: string, label = "name") => ({
	instance_id: instance,
	nodeset,
	label,
	value: "code",
	sort: "",
});

const TABLE = itemset("item-list:t", "instance('item-list:t')/t_list/t");

interface Case {
	readonly title: string;
	readonly edit: (body: JsonObject) => void;
	/** Each finding as `[code, place kind, detail.name]`, in the account's order. */
	readonly findings: readonly (readonly [string, string, string])[];
}

const first = (body: JsonObject) => promptsOf(body)[0] as JsonObject;
const third = (body: JsonObject) => promptsOf(body)[2] as JsonObject;

const CASES: readonly Case[] = [
	{
		title: "a name HQ reads as a request setting of its own",
		edit: (body) => renameFirst(body, "case_type"),
		findings: [
			[
				`${S}a-prompt-that-reaches-hq-as-its-own-key-named-as-a-config-keys`,
				"search",
				"case_type",
			],
		],
	},
	// HQ leaves these unsearched or reads them as filters of their own
	// (`case_search/models.py::UNSEARCHABLE_KEYS`, `case_search/utils.py::_apply_filter`), and a key
	// under `indices.` as a reverse-index filter, never as the property the name spells.
	...["include_closed", "commcare_project", "case_types", "indices.parent"].map(
		(name): Case => ({
			title: `the name ${name}, which HQ never searches as a property`,
			edit: (body) => renameFirst(body, name),
			findings: [
				[
					`${S}a-prompt-that-reaches-hq-as-its-own-key-named-as-a-config-keys`,
					"search",
					name,
				],
			],
		}),
	),
	{
		title: "a name outside Nova's name grammar",
		edit: (body) => renameFirst(body, "1st"),
		findings: [[`${S}prompt-key-outside-nova-s-name-grammar`, "search", "1st"]],
	},
	{
		title:
			"a name outside Nova's property grammar on a field that matches its property",
		edit: (body) => renameFirst(body, "_x"),
		findings: [[`${S}prompt-key-outside-nova-s-name-grammar`, "search", "_x"]],
	},
	{
		title: "a blank answer searched for on a hidden value",
		edit: (body) => {
			Object.assign(first(body), {
				hidden: true,
				exclude: true,
				default_value: "'north'",
				allow_blank_value: true,
				required: { doc_type: "Assertion", test: null, text: {} },
				validations: [],
			});
		},
		findings: [
			[`${S}allow-blank-value-on-a-hidden-prompt`, "search", "case_name"],
		],
	},
	{
		// HQ reads a shown owner_id prompt as the owner filter, which refuses the blank sent
		// beside an answer (`SearchCriteria._validate_multiple_terms`).
		title: "a search for blank beside the case owner",
		edit: (body) => {
			renameFirst(body, "owner_id");
			first(body).allow_blank_value = true;
		},
		findings: [
			[
				`${S}allow-blank-value-on-a-prompt-named-owner-id`,
				"search",
				"owner_id",
			],
		],
	},
	{
		title: "a value received from another screen",
		edit: (body) => {
			first(body).receiver_expression =
				"instance('casedb')/casedb/case/@case_id";
		},
		findings: [[`${S}receiver-expression`, "search", "case_name"]],
	},
	{
		title: "an address field that is required",
		edit: (body) => {
			first(body).appearance = "address";
		},
		findings: [
			[
				`${S}appearance-address-with-required-or-validations`,
				"search",
				"case_name",
			],
		],
	},
	{
		title: "an address field",
		edit: (body) => {
			const prompt = first(body);
			delete prompt.required;
			prompt.appearance = "address";
		},
		findings: [
			[
				`${S}appearance-address-geocoder-broadcast-emitted-input-address`,
				"search",
				"case_name",
			],
		],
	},
	{
		title: "a hidden field that is required",
		edit: (body) => {
			first(body).hidden = true;
		},
		findings: [
			[
				`${S}hidden-together-with-required-or-validations`,
				"search",
				"case_name",
			],
		],
	},
	{
		title: "a hidden field matched by its own name",
		edit: (body) => {
			const prompt = first(body);
			delete prompt.required;
			prompt.hidden = true;
			prompt.default_value = "'north'";
		},
		findings: [
			[
				`${S}hidden-without-exclude-on-a-prompt-with-no-itemset-input-type-or`,
				"search",
				"case_name",
			],
		],
	},
	{
		title: "a hidden field with a widget",
		edit: (body) => {
			const prompt = first(body);
			delete prompt.required;
			prompt.hidden = true;
			prompt.exclude = true;
			prompt.default_value = "'north'";
			prompt.input_ = "daterange";
		},
		findings: [
			[
				`${S}hidden-on-a-prompt-that-carries-an-itemset-input-type-or`,
				"search",
				"case_name",
			],
		],
	},
	{
		title: "a second validation",
		edit: (body) => {
			const validations = third(body).validations as JsonObject[];
			validations.push({ test: "true()", text: { es: "Otra", en: "Another" } });
		},
		findings: [[`${S}validations-1`, "search", "status"]],
	},
	{
		title: "a requirement with no message in any language",
		edit: (body) => {
			(first(body).required as JsonObject).text = { es: "", en: "" };
		},
		findings: [
			[
				`${S}a-required-or-validation-test-with-no-message-in-any-language`,
				"search",
				"case_name",
			],
		],
	},
	{
		title: "a field whose choices come from a mobile report",
		edit: (body) => {
			const prompt = first(body);
			prompt.input_ = "select1";
			prompt.itemset = itemset(
				"commcare-reports:abc",
				"instance('commcare-reports:abc')/rows/row",
			);
		},
		findings: [
			[
				`${S}input-select1-select-commcare-reports-itemset-mobile-ucr`,
				"search",
				"case_name",
			],
		],
	},
	{
		title: "a field whose choices come from another source",
		edit: (body) => {
			const prompt = first(body);
			prompt.input_ = "select1";
			prompt.itemset = itemset(
				"locations",
				"instance('locations')/locations/location",
			);
		},
		findings: [
			[
				`${S}itemset-scheme-other-than-item-list-commcare-reports`,
				"search",
				"case_name",
			],
		],
	},
	{
		title: "a field whose choice labels read an attribute",
		edit: (body) => {
			const prompt = first(body);
			prompt.input_ = "select1";
			prompt.itemset = itemset(
				"item-list:t",
				"instance('item-list:t')/t_list/t",
				"@name",
			);
		},
		findings: [
			[
				`${S}itemset-refs-to-item-attributes-attr-or-property-qualified`,
				"search",
				"case_name",
			],
		],
	},
	{
		title: "a field whose choices name no instance",
		edit: (body) => {
			const prompt = first(body);
			prompt.input_ = "select1";
			const unnamed: JsonObject = { ...TABLE };
			delete unnamed.instance_id;
			prompt.itemset = unnamed;
		},
		findings: [
			[
				`${S}itemset-without-the-item-list-its-instance-id-names`,
				"search",
				"case_name",
			],
		],
	},
	{
		title:
			"a field whose choices read another table than the one its instance names",
		edit: (body) => {
			const prompt = first(body);
			prompt.input_ = "select1";
			prompt.itemset = itemset(
				"item-list:t",
				"instance('item-list:u')/u_list/u",
			);
		},
		findings: [
			[
				`${S}itemset-without-the-item-list-its-instance-id-names`,
				"search",
				"case_name",
			],
		],
	},
	{
		title: "an input type no runtime names",
		edit: (body) => {
			first(body).input_ = "slider";
		},
		findings: [[`${S}input-no-runtime-names`, "search", "case_name"]],
	},
	{
		title: "an input type no runtime names, beside choices",
		edit: (body) => {
			const prompt = first(body);
			prompt.input_ = "slider";
			prompt.itemset = TABLE;
		},
		findings: [[`${S}input-no-runtime-names`, "search", "case_name"]],
	},
	{
		title: "an address input type",
		edit: (body) => {
			first(body).input_ = "address";
		},
		findings: [
			[
				`${S}appearance-address-geocoder-broadcast-emitted-input-address`,
				"search",
				"case_name",
			],
		],
	},
	{
		// HQ's Case List page blanks every check of an address field on a save, so the second
		// validation is the address field's finding, not one of its own beside it.
		title: "an address field with a second validation",
		edit: (body) => {
			const prompt = third(body);
			prompt.appearance = "address";
			const validations = prompt.validations as JsonObject[];
			validations.push({ test: "true()", text: { es: "Otra", en: "Another" } });
		},
		findings: [
			[
				`${S}appearance-address-with-required-or-validations`,
				"search",
				"status",
			],
		],
	},
	{
		title: "an address input type beside an address appearance",
		edit: (body) => {
			const prompt = first(body);
			delete prompt.required;
			prompt.appearance = "address";
			prompt.input_ = "address";
		},
		findings: [
			[
				`${S}appearance-address-geocoder-broadcast-emitted-input-address`,
				"search",
				"case_name",
			],
		],
	},
];

/** The document a reading of the edited export gives, with no finding and no defect, and the
 *  paths the reading records as respelled. */
async function documentOf(edit: (body: JsonObject) => void) {
	const body = exportedBody(PROMPTS);
	edit(body);
	const outcome = readHqApp(await inputFor(body));
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error(
			`The edited app read to an account: ${outcome.findings.map((one) => `${one.code} ${one.detail.name ?? ""}`).join(", ")}.`,
		);
	return {
		doc: outcome.draft.doc,
		respelled: outcome.draft.facts.sameStateRewrites.map(
			(one) => [one.entry, one.path, one.register] as const,
		),
	};
}

async function account(edit: (body: JsonObject) => void) {
	const body = exportedBody(PROMPTS);
	edit(body);
	const outcome = readHqApp(await inputFor(body));
	expect(outcome.defects).toEqual([]);
	if (outcome.kind !== "account")
		throw new Error("The edited app read to a document, with no finding.");
	return outcome.findings.map(
		(finding) =>
			[finding.code, finding.place.kind, finding.detail.name ?? ""] as const,
	);
}

describe("a Search field CommCare HQ matches by its own rule", () => {
	// Each was a refusal until a field could take the project space's matching
	// (`matching: "project-space"`); now each reads with no finding.
	for (const [title, edit] of [
		[
			"named for a case attribute",
			(body: JsonObject) => renameFirst(body, "case_id"),
		],
		[
			"of a date",
			(body: JsonObject) => {
				first(body).input_ = "date";
			},
		],
		[
			"of a date over an address appearance",
			(body: JsonObject) => {
				const prompt = first(body);
				prompt.appearance = "address";
				prompt.input_ = "date";
			},
		],
	] as const)
		it(`reads one ${title} as a field the project space matches`, async () => {
			const { doc } = await documentOf(edit);
			const fields = Object.values(doc.modules).flatMap(
				(module) => module.caseListConfig?.searchInputs ?? [],
			);
			expect(
				fields.some(
					(field) =>
						field.kind === "simple" && field.matching === "project-space",
				),
			).toBe(true);
		});
});

// HQ matches a prompt named for the case's name or id by the bare key, the blank sent
// beside the answer included (`case_search/utils.py::_get_case_property_query`), so the field the
// project space matches carries its search for blank, and the gate admits the reading.
describe("a search for blank on a field CommCare HQ matches by its own rule", () => {
	it.each(["name", "case_id"])(
		"reads %s with its search for blank, and the gate admits it",
		async (name) => {
			const { doc } = await documentOf((body) => {
				renameFirst(body, name);
				first(body).allow_blank_value = true;
			});
			const field = Object.values(doc.modules)
				.flatMap((module) => module.caseListConfig?.searchInputs ?? [])
				.find((one) => one.name === name);
			expect(field).toMatchObject({
				kind: "simple",
				matching: "project-space",
				allowBlank: true,
			});
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		},
	);
});

// HQ's Case List page hides a field and leaves it out of the request with no starting value; Web
// Apps holds it blank, and Android shows it empty (`RemoteQuerySessionManager.initUserAnswers`
// seeds an answer only from a starting value), so Nova holds it as a hidden field with none.
describe("a hidden field CommCare HQ holds with no value", () => {
	it("reads as a hidden field with no value, and the gate admits it", async () => {
		const { doc } = await documentOf((body) => {
			const prompt = first(body);
			delete prompt.required;
			prompt.hidden = true;
			prompt.exclude = true;
		});
		const field = Object.values(doc.modules)
			.flatMap((module) => module.caseListConfig?.searchInputs ?? [])
			.find((one) => one.name === "case_name");
		expect(field).toMatchObject({ kind: "hidden", name: "case_name" });
		expect(field && "value" in field).toBe(false);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});
});

describe("a Search field Nova cannot hold", () => {
	it("is no finding where nothing was edited", async () => {
		const outcome = readHqApp(await inputFor(exportedBody(PROMPTS)));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("read");
	});

	for (const one of CASES)
		it(`for ${one.title} is its one finding, and nothing else the search holds is one`, async () => {
			expect(await account(one.edit)).toEqual(one.findings);
		});

	// A group's own entry is no field: it is one finding naming the group, which each member's
	// `group_key` names too, and a member with no `group_key` beside groups is a finding of its own.
	it("for a search with groups is one finding for the groups, and one for a member in none", async () => {
		const header = {
			name: "g",
			label: { es: "Grupo", en: "Group" },
			is_group: true,
			group_key: "g",
		};
		expect(
			await account((body) => {
				const prompts = promptsOf(body);
				for (const prompt of prompts) prompt.group_key = "g";
				prompts.unshift(header);
			}),
		).toEqual([[`${S}is-group-group-key`, "search", "g"]]);
		const missing = await account((body) => {
			const prompts = promptsOf(body);
			for (const prompt of prompts.slice(1)) prompt.group_key = "g";
			prompts.unshift(header);
		});
		expect(new Set(missing)).toEqual(
			new Set([
				[`${S}is-group-group-key`, "search", "g"],
				[
					`${S}groups-present-and-an-input-without-group-key`,
					"search",
					"case_name",
				],
			]),
		);
		expect(missing).toHaveLength(2);
	});

	// The filter keyed by a plain property is a finding of its own, and its value stands under it.
	it("for a name a default filter shares is its one finding, beside the filter's own", async () => {
		expect(
			await account((body) => {
				const modules = body.modules as JsonObject[];
				const config = modules[0]?.search_config as JsonObject;
				(config.default_properties as JsonObject[]).push({
					property: "case_name",
					defaultValue: "'Ana'",
				});
			}),
		).toEqual([
			[
				`${S}a-default-filter-and-a-search-property-sharing-one-name`,
				"search",
				"case_name",
			],
		]);
	});

	it("for a validation with no message in any language is its one finding", async () => {
		const found = await account((body) => {
			const [validation] = third(body).validations as JsonObject[];
			if (validation === undefined) throw new Error("status validates.");
			validation.text = { es: "", en: "" };
		});
		expect(found).toEqual([
			[
				`${S}a-required-or-validation-test-with-no-message-in-any-language`,
				"search",
				"status",
			],
		]);
	});

	// Over a table the project space holds, a column the table lacks is one finding, and a table
	// the reading was not told of is handed to project data's rules, which settle it, with no
	// finding of the reader's beside it: the field's read of the table and each filter row of its
	// search, which waits on the field, are handed off together.
	describe("over a lookup table", () => {
		const withTable = (input: ReaderInputOf): ReaderInputOf => ({
			...input,
			lookup: {
				...input.lookup,
				table: (tag) =>
					tag === "t"
						? {
								tableId:
									"01890000-0000-7000-8000-000000000301" as LookupTableId,
								column: (name) =>
									name === "code"
										? ("01890000-0000-7000-8000-000000000302" as LookupColumnId)
										: undefined,
							}
						: undefined,
			},
		});
		// The table `t` as project data defines it, for a reading that binds its reads.
		const TABLE_T = {
			id: "01890000-0000-7000-8000-000000000301" as LookupTableId,
			name: "T",
			tag: "t",
			columns: [
				{
					id: "01890000-0000-7000-8000-000000000302" as LookupColumnId,
					wireName: "code",
					label: "Code",
					dataType: "text" as const,
				},
			],
		};
		const overTable = (body: JsonObject) => {
			const prompt = first(body);
			prompt.input_ = "select1";
			prompt.itemset = TABLE;
		};

		it.each(["", "address"])(
			"reads a lookup checkbox even with a stored %s appearance",
			async (appearance) => {
				const body = exportedBody(PROMPTS);
				const prompt = first(body);
				prompt.input_ = "checkbox";
				prompt.appearance = appearance;
				prompt.itemset = {
					...TABLE,
					label: "code",
					value: "code",
					sort: "code",
				};
				const told = withTable(await inputFor(body));
				const outcome = readHqApp({
					...told,
					lookup: {
						...told.lookup,
						definitions: new Map([[TABLE_T.id, TABLE_T]]),
					},
				});
				expect(outcome.defects).toEqual([]);
				if (outcome.kind !== "read")
					throw new Error(JSON.stringify(outcome.findings));
				const doc = outcome.draft.doc;
				expect(
					doc.modules[doc.moduleOrder[0]].caseListConfig?.searchInputs[0],
				).toMatchObject({
					type: "checkboxes",
					name: "case_name",
					options: {
						kind: "lookup",
						tableId: TABLE_T.id,
						valueColumnId: TABLE_T.columns[0].id,
						labelColumnId: TABLE_T.columns[0].id,
					},
				});
			},
		);

		// A ref to a column the table lacks reads blank for every choice on a device: a read of what
		// is not there, the expression entry's own finding, once for the field.
		const MISSING =
			"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant";
		for (const [title, refs] of [
			["a label column", { label: "name" }],
			["a value column", { label: "code", value: "name" }],
			["a sort column", { label: "code", sort: "rank" }],
			["a label and a value column", { label: "name", value: "kind" }],
		] as const)
			it(`${title} the table lacks is one finding`, async () => {
				const body = exportedBody(PROMPTS);
				overTable(body);
				first(body).itemset = { ...TABLE, ...refs };
				const outcome = readHqApp(withTable(await inputFor(body)));
				expect(outcome.defects).toEqual([]);
				if (outcome.kind !== "account") throw new Error("read with no finding");
				expect(
					outcome.findings.map((one) => [
						one.code,
						one.place.kind,
						one.detail.name,
						one.detail.reason,
					]),
				).toEqual([[MISSING, "search", "case_name", "parse:unknown-column"]]);
			});

		// A filter row's value a device reads from a table, as from the cases on the device, is the
		// one entry for values that query device data, at the search.
		it.each([
			["a told table", "instance('item-list:t')/t_list/t[1]/code"],
			[
				"the cases on the device",
				"instance('casedb')/casedb/case[1]/case_name",
			],
		])(
			"a filter row's value read from %s is that one finding",
			async (_title, read) => {
				const body = exportedBody(PROMPTS);
				const config = (body.modules as JsonObject[])[0]
					?.search_config as JsonObject;
				(config.default_properties as JsonObject[]).push({
					property: "_xpath_query",
					doc_type: "DefaultCaseSearchProperty",
					defaultValue: `concat("case_name = '", ${read}, "'")`,
				});
				const told = withTable(await inputFor(body));
				const outcome = readHqApp({
					...told,
					lookup: {
						...told.lookup,
						definitions: new Map([[TABLE_T.id, TABLE_T]]),
					},
				});
				expect(outcome.defects).toEqual([]);
				if (outcome.kind !== "account") throw new Error("read with no finding");
				expect(
					outcome.findings.map((one) => [
						one.code,
						one.place.kind,
						one.detail.name,
					]),
				).toEqual([
					[
						`${S}a-search-value-that-queries-cases-a-table-or-places`,
						"search",
						"_xpath_query",
					],
				]);
			},
		);

		it("a table the reading was not told of is handed off, and nothing else is a finding", async () => {
			const body = exportedBody(PROMPTS);
			overTable(body);
			const outcome = readHqApp(await inputFor(body));
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind).toBe("read");
			expect(
				outcome.claims.handOffs.map((one) => [one.to, one.subject, one.key]),
			).toEqual([
				["lookup-table-read", "t", "schema:Itemset.instance_id"],
				[
					"lookup-table-read",
					"t",
					"schema:DefaultCaseSearchProperty.defaultValue",
				],
			]);
		});
	});

	// Two causes in one prompt are two findings, each its own: the reading goes on past the first.
	it("for two causes in one prompt is a finding for each", async () => {
		const found = await account((body) => {
			const prompt = first(body);
			prompt.receiver_expression = "instance('casedb')/casedb/case/@case_id";
			prompt.validations = [
				{ doc_type: "Assertion", test: "true()", text: { en: "One" } },
				{ doc_type: "Assertion", test: "true()", text: { en: "Two" } },
			];
		});
		expect(new Set(found)).toEqual(
			new Set([
				[`${S}validations-1`, "search", "case_name"],
				[`${S}receiver-expression`, "search", "case_name"],
			]),
		);
		expect(found).toHaveLength(2);
	});

	// A widget HQ's build writes no part of is no widget: a blank `input_` or `appearance` (which
	// HQ's build reads only where it holds text, `if prop.input_`, `if prop.appearance`), and an
	// address appearance beside a date range (whose `input_` HQ's build writes over the address
	// field's `input`). Each reads to the document of the field without it, the key recorded as
	// respelled, since the first publish writes it no more.
	describe("beside a widget HQ's build writes no part of", () => {
		const BLANK = `${S}a-blank-text-in-a-search-key-hq-reads-only-where-it-holds-text`;
		const UNDER = `${S}appearance-address-beside-an-input-hq-s-build-writes-over-it`;
		const AT = "/modules/0/search_config/properties/0";

		it("a blank input type and appearance read as the plain text field", async () => {
			const plain = await documentOf(() => {});
			const blank = await documentOf((body) => {
				const prompt = first(body);
				prompt.input_ = "";
				prompt.appearance = "";
			});
			expect(blank.doc).toEqual(plain.doc);
			expect(blank.respelled).toEqual(
				expect.arrayContaining([
					[BLANK, `${AT}/input_`, "list-settings-respelled"],
					[BLANK, `${AT}/appearance`, "list-settings-respelled"],
				]),
			);
		});

		// The first prompt holds a hint, which a hidden prompt shows nowhere: Web Apps hides the
		// prompt and Android shows its label alone, so the Hidden Value holds none.
		const hide = (prompt: JsonObject) => {
			delete prompt.required;
			prompt.hidden = true;
			prompt.exclude = true;
			prompt.default_value = "'north'";
		};

		it("a hidden value's hint is shown nowhere and read as nothing", async () => {
			const unhinted = await documentOf((body) => {
				const prompt = first(body);
				hide(prompt);
				delete prompt.hint;
			});
			const hinted = await documentOf((body) => hide(first(body)));
			expect(hinted.doc).toEqual(unhinted.doc);
			expect(hinted.respelled).toContainEqual([
				`${S}hint-on-a-hidden-prompt`,
				`${AT}/hint`,
				"list-settings-respelled",
			]);
		});

		it("a hidden value's blank input type and appearance are no widget", async () => {
			const hidden = await documentOf((body) => hide(first(body)));
			const blank = await documentOf((body) => {
				const prompt = first(body);
				hide(prompt);
				prompt.input_ = "";
				prompt.appearance = "";
			});
			expect(blank.doc).toEqual(hidden.doc);
		});

		it("an address appearance beside a date range is the date range, its requirement no address field's", async () => {
			// `case_name` is text in the catalog, so the date range is its own finding; with the
			// address appearance beside it, that finding stands alone.
			const range = await account((body) => {
				first(body).input_ = "daterange";
			});
			expect(range).toEqual([
				[
					`${S}search-field-over-a-property-of-another-type`,
					"search",
					"case_name",
				],
			]);
			expect(
				await account((body) => {
					const prompt = first(body);
					prompt.input_ = "daterange";
					prompt.appearance = "address";
				}),
			).toEqual(range);
		});

		it("an address appearance beside an excluded date range reads as that date range", async () => {
			const exclude = (prompt: JsonObject) => {
				prompt.input_ = "daterange";
				prompt.exclude = true;
			};
			const range = await documentOf((body) => exclude(first(body)));
			const under = await documentOf((body) => {
				const prompt = first(body);
				exclude(prompt);
				prompt.appearance = "address";
			});
			expect(under.doc).toEqual(range.doc);
			expect(under.respelled).toContainEqual([
				UNDER,
				`${AT}/appearance`,
				"list-settings-respelled",
			]);
		});
	});

	// A value received beside an appearance HQ's editor sets is its own entry, and the address
	// field is a finding of its own beside it.
	it("for a value received on an address field is a finding for each", async () => {
		const found = await account((body) => {
			const prompt = first(body);
			delete prompt.required;
			prompt.appearance = "address";
			prompt.receiver_expression = "instance('casedb')/casedb/case/@case_id";
		});
		expect(new Set(found)).toEqual(
			new Set([
				[
					`${S}receiver-expression-on-a-prompt-whose-editor-appearance-is`,
					"search",
					"case_name",
				],
				[
					`${S}appearance-address-geocoder-broadcast-emitted-input-address`,
					"search",
					"case_name",
				],
			]),
		);
		expect(found).toHaveLength(2);
	});

	// HQ's Case List page shows a barcode appearance as its own, and a date input over any
	// appearance (`case_claim.js::_getAppearance`): a value received on either is that entry alone.
	const RECEIVED_ON_WIDGET = [
		`${S}receiver-expression-on-a-prompt-whose-editor-appearance-is`,
		"search",
		"case_name",
	] as const;

	it("for a value received on a barcode field is the editor appearance's entry alone", async () => {
		const found = await account((body) => {
			const prompt = first(body);
			prompt.appearance = "barcode_scan";
			prompt.receiver_expression = "home-address";
		});
		expect(found).toEqual([RECEIVED_ON_WIDGET]);
	});

	it("for a value received on a date field is the editor appearance's entry, whatever the appearance", async () => {
		const found = await account((body) => {
			const prompt = first(body);
			prompt.input_ = "date";
			prompt.appearance = "barcode_scan";
			prompt.receiver_expression = "home-address";
		});
		expect(
			found.filter(([code]) => code.startsWith(`${S}receiver-expression`)),
		).toEqual([RECEIVED_ON_WIDGET]);
	});
});
