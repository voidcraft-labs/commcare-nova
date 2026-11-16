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
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
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
		title: "a name of a case attribute HQ matches by its own rule",
		edit: (body) => renameFirst(body, "case_id"),
		findings: [
			[
				`${S}prompt-named-for-a-case-attribute-hq-matches-itself`,
				"search",
				"case_id",
			],
		],
	},
	{
		title: "a blank answer searched for",
		edit: (body) => {
			first(body).allow_blank_value = true;
		},
		findings: [[`${S}allow-blank-value`, "search", "case_name"]],
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
		title: "a hidden field with no value",
		edit: (body) => {
			const prompt = first(body);
			delete prompt.required;
			prompt.hidden = true;
			prompt.exclude = true;
		},
		findings: [
			[
				`${S}hidden-exclude-without-a-default-value-on-a-prompt-with-no`,
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
		title: "a date field matched by HQ's own rule",
		edit: (body) => {
			first(body).input_ = "date";
		},
		findings: [
			[`${S}date-prompt-matched-by-hq-s-own-rule`, "search", "case_name"],
		],
	},
	{
		title: "a checkbox field",
		edit: (body) => {
			const prompt = first(body);
			prompt.input_ = "checkbox";
			prompt.itemset = TABLE;
		},
		findings: [[`${S}input-checkbox-itemset`, "search", "case_name"]],
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
		title: "a starting value on a date range",
		edit: (body) => {
			const prompt = first(body);
			prompt.input_ = "daterange";
			prompt.default_value = "'2020-01-01'";
		},
		findings: [
			[`${S}default-value-on-a-date-range-input`, "search", "case_name"],
		],
	},
	{
		title: "an input type no runtime names",
		edit: (body) => {
			first(body).input_ = "slider";
		},
		findings: [["unrecognized", "search", "schema:CaseSearchProperty.input_"]],
	},
];

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
				`${S}default-properties-entry-keyed-by-a-plain-property-property-p`,
				"search",
				"case_name",
			],
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
		const overTable = (body: JsonObject) => {
			const prompt = first(body);
			prompt.input_ = "select1";
			prompt.itemset = TABLE;
		};

		it("a label column the table lacks is one finding", async () => {
			const body = exportedBody(PROMPTS);
			overTable(body);
			const outcome = readHqApp(withTable(await inputFor(body)));
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "account") throw new Error("read with no finding");
			expect(
				outcome.findings.map((one) => [
					one.code,
					one.place.kind,
					one.detail.name,
				]),
			).toEqual([["unrecognized", "search", "schema:Itemset.value"]]);
		});

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
			prompt.allow_blank_value = true;
			prompt.receiver_expression = "instance('casedb')/casedb/case/@case_id";
		});
		expect(new Set(found)).toEqual(
			new Set([
				[`${S}allow-blank-value`, "search", "case_name"],
				[`${S}receiver-expression`, "search", "case_name"],
			]),
		);
		expect(found).toHaveLength(2);
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
});
