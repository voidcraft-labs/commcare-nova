/**
 * The CSQL texts the search row reader is held to, with what it reads each
 * as, over one real document. The same vectors feed the proof lane, where
 * HQ's own CSQL parser and filter builder read each text
 * (`proof/native/test_csql_reader_parity.py`): a text HQ builds must be one
 * the reader holds or claims under a manifest entry, and a text HQ refuses
 * one the reader refuses under a REFUSED entry.
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	eq,
	input,
	prop,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import {
	type ExpressionContext,
	slotContext,
} from "@/lib/domain/expression/context";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import {
	advancedSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import type { Uuid } from "@/lib/domain/uuid";
import { w } from "../../../xpath/wire/builders";
import { serializeWire } from "../../../xpath/wire/serialize";
import type { SearchRowEnv } from "../csqlRead";

export const REGION = testUuid("00000000-0000-4000-8000-0000000c5a01");
export const BORN = testUuid("00000000-0000-4000-8000-0000000c5a02");

/** A menu of patients whose search has an advanced field `region` over the
 *  village and a simple date field `dob`, which derives a match of its own,
 *  and whose case list holds `filter` where one is given. */
export function csqlVectorDoc(filter?: Expression): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	if (filter !== undefined) config.filter = filter;
	config.searchInputs = [
		advancedSearchInputDef(
			REGION,
			"region",
			"Region",
			"text",
			whenInput(
				input(REGION),
				eq(prop("patient", "village"), term(input(REGION))),
			),
		),
		simpleSearchInputDef(BORN, "dob", "Born", "date", "dob"),
	];
	return buildDoc({
		appName: "Search rows",
		caseTypes: [
			{
				name: "patient",
				properties: [
					// A text property: one the catalog holds untyped takes the type
					// a row's ordering against a date gives it.
					{ name: "village", label: proseText("Village"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
					{ name: "seen", label: proseText("Seen"), data_type: "datetime" },
					{
						name: "tags",
						label: proseText("Tags"),
						data_type: "multi_select",
					},
				],
			},
			// A patient's subcases, which a row counts.
			{ name: "visit", parent_type: "patient", properties: [] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: {},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
}

/** The one menu of a vector document. */
export function patientsMenu(doc: BlueprintDoc): Uuid {
	return doc.moduleOrder[0] as Uuid;
}

/** The context of the menu's case list filter, or of its `region` field's condition. */
export function rowContext(
	doc: BlueprintDoc,
	slot: "case_list_filter" | "search_input_predicate" = "case_list_filter",
): ExpressionContext {
	const ref: SlotContextRef =
		slot === "case_list_filter"
			? { entity: "module", uuid: patientsMenu(doc), slot }
			: {
					entity: "module",
					uuid: patientsMenu(doc),
					slot,
					member: { searchInputUuid: REGION },
				};
	const context = slotContext(doc, ref, new Map());
	if (context === undefined)
		throw new Error(`No ${slot} slot in the document.`);
	return context;
}

export function rowEnv(doc: BlueprintDoc): SearchRowEnv {
	return { doc, lookup: new Map() };
}

/** A constant CSQL text as the `_xpath_query` value that sends it: one XPath
 *  string, spelled by the production serializer. */
export function csqlRow(csql: string): string {
	return serializeWire(w.str(csql), {
		target: "hq-json",
		interpolation: "none",
	}).text;
}

export interface CsqlReaderVector {
	readonly id: string;
	/** The CSQL text, as HQ's search receives it. */
	readonly csql: string;
	/** Held, at a level with its rewrites; or claimed under an entry. */
	readonly reads:
		| {
				readonly held: "exact" | "guards";
				readonly rewrites: readonly string[];
		  }
		| { readonly entry: string };
}

const EXACT = { held: "exact", rewrites: [] } as const;

export const CSQL_READER_VECTORS: readonly CsqlReaderVector[] = [
	{ id: "equality", csql: "village = 'north'", reads: EXACT },
	{ id: "inequality", csql: "village != 'north'", reads: EXACT },
	{ id: "blank", csql: "village = ''", reads: EXACT },
	{ id: "number-ordered", csql: "age > 3", reads: EXACT },
	{ id: "negative-number", csql: "age >= -2", reads: EXACT },
	{ id: "date-ordered", csql: "dob > '2000-01-01'", reads: EXACT },
	{ id: "match-all", csql: "match-all()", reads: EXACT },
	{ id: "or", csql: "village = 'a' or village = 'b'", reads: EXACT },
	{ id: "and", csql: "village = 'a' and age > 3", reads: EXACT },
	{ id: "not", csql: "not(village = 'a')", reads: EXACT },
	{ id: "selected", csql: "selected(tags, 'a')", reads: EXACT },
	{ id: "fuzzy-match", csql: "fuzzy-match(village, 'nrth')", reads: EXACT },
	{ id: "starts-with", csql: "starts-with(village, 'no')", reads: EXACT },
	{
		id: "server-today",
		csql: "dob < today()",
		reads: { held: "guards", rewrites: ["search-today-device-day"] },
	},
	{
		id: "text-ordered-against-a-date",
		csql: "village > '2020-01-01'",
		reads: {
			entry: "case-search/xpath-query-condition-outside-what-nova-types",
		},
	},
	{
		id: "system-date-ordered",
		csql: "date_opened > '2023-01-01'",
		reads: {
			entry:
				"case-search/date-only-comparison-on-date-opened-closed-on-last-modified",
		},
	},
	{
		id: "system-date-equality",
		csql: "date_opened = '2023-01-01'",
		reads: {
			entry:
				"case-search/date-only-comparison-on-date-opened-closed-on-last-modified",
		},
	},
	{
		id: "function-on-the-left",
		csql: "today() = village",
		reads: {
			entry:
				"case-search/a-function-on-the-left-side-a-property-on-the-right-side",
		},
	},
	{
		id: "property-on-the-right",
		csql: "village = region",
		reads: {
			entry:
				"case-search/a-function-on-the-left-side-a-property-on-the-right-side",
		},
	},
	{
		id: "text-ordered-against-text",
		csql: "village > 'm'",
		reads: {
			entry:
				"case-search/p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of",
		},
	},
	{
		id: "unparenthesized-second-argument",
		csql: "dob > date-add('2020-01-01', 'days', double(3))",
		reads: {
			entry:
				"case-search/a-function-call-written-unparenthesized-as-the-2nd-or-later",
		},
	},
];
