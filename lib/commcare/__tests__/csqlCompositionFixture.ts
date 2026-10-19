/**
 * The `csql` native family's statement of meaning: one document per
 * scenario, the cases HQ's receiver saves for it, and for each search the
 * session it is sent under and the case ids it means
 * (`docs/plans/hq-round-trip/3-expressions/06-csql.md` §8).
 *
 * HQ's check (`proof/native/test_csql_payload.py`) saves each scenario's
 * cases through HQ's receiver, so every stored date and time is HQ's own
 * spelling, and holds HQ's case search over them to `expected`. Preview's
 * check reads the same fixture, so both sides answer to one meaning.
 *
 * A scenario's searches are its document's modules, in order: search `i` is
 * module `i`'s, sent as Core's `search_command.m<i>`.
 */

import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	blueprintDocSchema,
	type CaseListConfig,
	plainColumn,
	proseText,
	type SearchInputDef,
} from "@/lib/domain";
import {
	datetimeCoerce,
	datetimeLiteral,
	type Expression,
	eq,
	input,
	isIn,
	matchAll,
	neq,
	prop,
	term,
	whenInput,
} from "@/lib/domain/expression";
import { runValidation } from "../validator/runner";

/** One case as HQ's receiver is asked to save it (`CaseBlock` fields). */
export interface CsqlCase {
	readonly id: string;
	readonly type: string;
	readonly name: string;
	/** Custom properties as submitted; HQ's receiver rewrites datetimes. */
	readonly properties: Readonly<Record<string, string>>;
	/** The block's `date_modified` (UTC), which HQ makes the case's
	 * `modified_on` and, on create, its `opened_on`. */
	readonly modified: string;
	readonly closed?: boolean;
	readonly indices?: readonly {
		readonly identifier: string;
		readonly caseType: string;
		readonly caseId: string;
		readonly relationship: "child" | "extension";
	}[];
}

/** One sending of a search: what Core is answered with, and what it means. */
export interface CsqlSending {
	readonly id: string;
	/** Each search input's answer by its wire name; `null` leaves it unanswered. */
	readonly answers?: Readonly<Record<string, string | null>>;
	/** The case ids the search means, in any order. */
	readonly expected: readonly string[];
}

export interface CsqlSearch {
	/** A stable name for the search, also its module's name. */
	readonly id: string;
	readonly sendings: readonly CsqlSending[];
}

export interface CsqlScenario {
	readonly id: string;
	readonly caseTypes: readonly string[];
	readonly cases: readonly CsqlCase[];
	readonly searches: readonly CsqlSearch[];
	readonly doc: () => BlueprintDoc;
}

/** The serializable half a producer writes beside the scenario's exports. */
export function scenarioRecord(scenario: CsqlScenario) {
	return {
		id: scenario.id,
		caseTypes: scenario.caseTypes,
		cases: scenario.cases,
		searches: scenario.searches.map((search, module) => ({
			...search,
			command: `search_command.m${module}`,
		})),
	};
}

// --- datetime-equality (§3.13, finding 75) ---------------------------------

const VISIT = "visit";
const uuid = (scenario: string, name: string) =>
	testUuid(`csql-${scenario}-${name}`);

/** The instant every spelling below names: 2026-01-02 04:30 UTC. */
const INSTANT = "2026-01-02T04:30:00";
/** The instant "Opened visits" and "Modified visits" ask for. */
const OPENED = "2026-01-02T09:30";
const SEEN_AT_INSTANT = [
	"csql-visit-plus-0530",
	"csql-visit-minus-05",
	"csql-visit-zulu",
] as const;
const OTHER = "csql-visit-other";
const UNSEEN = "csql-visit-unseen";
const OPENED_CASE = "csql-visit-opened";

const datetimeEqualityCases: readonly CsqlCase[] = [
	{
		id: SEEN_AT_INSTANT[0],
		type: VISIT,
		name: "Amina",
		properties: { seen: "2026-01-02T10:00:00.000+05:30" },
		modified: "2026-01-01T08:00:00.000000Z",
	},
	{
		id: SEEN_AT_INSTANT[1],
		type: VISIT,
		name: "Baraka",
		properties: { seen: "2026-01-01T23:30:00.000-05" },
		modified: "2026-01-01T08:00:00.000000Z",
	},
	{
		id: SEEN_AT_INSTANT[2],
		type: VISIT,
		name: "Chidi",
		properties: { seen: "2026-01-02T04:30:00.000Z" },
		modified: "2026-01-01T08:00:00.000000Z",
	},
	{
		id: OTHER,
		type: VISIT,
		name: "Dalia",
		properties: { seen: "2026-01-02T05:30:00.000Z" },
		modified: "2026-01-01T08:00:00.000000Z",
	},
	{
		id: UNSEEN,
		type: VISIT,
		name: "Emeka",
		properties: {},
		modified: "2026-01-01T08:00:00.000000Z",
	},
	{
		id: OPENED_CASE,
		type: VISIT,
		name: "Farah",
		properties: {},
		modified: "2026-01-02T09:30:00.000000Z",
	},
];

/** The runtime value's input: a text answer coerced to a date and time. */
const SEEN_INPUT = "seen_at";

function datetimeEqualityDoc(): BlueprintDoc {
	const id = (name: string) => uuid("datetime-equality", name);
	const seen = prop(VISIT, "seen");
	const runtime = id("runtime-input");
	const filtered = (name: string, filter: Expression) => ({
		name,
		config: { filter, searchInputs: [] as SearchInputDef[] },
	});
	const searches: {
		name: string;
		config: Partial<CaseListConfig>;
	}[] = [
		filtered("eq-naive", eq(seen, term(datetimeLiteral(INSTANT)))),
		filtered("eq-zulu", eq(seen, term(datetimeLiteral(`${INSTANT}Z`)))),
		filtered("eq-minute", eq(seen, term(datetimeLiteral("2026-01-02T04:30")))),
		{
			name: "eq-runtime",
			config: {
				filter: whenInput(
					input(runtime),
					eq(seen, datetimeCoerce(term(input(runtime)))),
				),
				searchInputs: [
					advancedSearchInputDef(
						runtime,
						SEEN_INPUT,
						"Seen at",
						"text",
						matchAll(),
					),
				],
			},
		},
		filtered("neq-naive", neq(seen, term(datetimeLiteral(INSTANT)))),
		filtered(
			"in-two",
			isIn(
				seen,
				datetimeLiteral(INSTANT),
				datetimeLiteral("2026-01-02T05:30:00"),
			),
		),
		...(
			[
				["date_opened", "opened_at"],
				["last_modified", "modified_at"],
			] as const
		).map(([property, name]) => ({
			name: `${property}-minute`,
			config: {
				searchInputs: [
					advancedSearchInputDef(
						id(`${property}-input`),
						name,
						"When",
						"text",
						eq(prop(VISIT, property), term(datetimeLiteral(OPENED))),
					),
				],
			},
		})),
	];
	const doc = buildDoc({
		appId: "csql-datetime-equality",
		appName: "Visit times",
		caseTypes: [
			{
				name: VISIT,
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "seen", label: proseText("Seen"), data_type: "datetime" },
				],
			},
		],
		modules: searches.map((search) => {
			const column = id(`${search.name}-name`);
			return {
				uuid: id(`${search.name}-module`),
				name: search.name,
				caseType: VISIT,
				caseSearchConfig: {},
				caseListConfig: {
					columns: [plainColumn(column, "case_name", "Name")],
					listColumnOrder: [column],
					detailColumnOrder: [column],
					searchInputs: [],
					...search.config,
				},
				forms: [
					{
						uuid: id(`${search.name}-review`),
						name: "Review visit",
						type: "followup" as const,
						fields: [
							f({
								kind: "text",
								uuid: id(`${search.name}-note`),
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			};
		}),
	});
	return admitted(doc);
}

const atInstant = [...SEEN_AT_INSTANT];

/** §3.13's scenario. `expected` is Nova's meaning, which Preview answers. */
export const datetimeEquality: CsqlScenario = {
	id: "datetime-equality",
	caseTypes: [VISIT],
	cases: datetimeEqualityCases,
	searches: [
		{ id: "eq-naive", sendings: [{ id: "literal", expected: atInstant }] },
		{ id: "eq-zulu", sendings: [{ id: "literal", expected: atInstant }] },
		{ id: "eq-minute", sendings: [{ id: "literal", expected: atInstant }] },
		{
			id: "eq-runtime",
			sendings: [
				{
					id: "plus-05",
					answers: { [SEEN_INPUT]: "2026-01-02T09:30:00.000+05" },
					expected: atInstant,
				},
				{
					id: "zulu",
					answers: { [SEEN_INPUT]: "2026-01-02T04:30:00.000Z" },
					expected: atInstant,
				},
			],
		},
		{
			id: "neq-naive",
			sendings: [{ id: "literal", expected: [OTHER, UNSEEN, OPENED_CASE] }],
		},
		{
			id: "in-two",
			sendings: [{ id: "literal", expected: [...atInstant, OTHER] }],
		},
		{
			id: "date_opened-minute",
			sendings: [{ id: "literal", expected: [OPENED_CASE] }],
		},
		{
			id: "last_modified-minute",
			sendings: [{ id: "literal", expected: [OPENED_CASE] }],
		},
	],
	doc: datetimeEqualityDoc,
};

/** Every scenario, in the order the family writes and checks them. */
export const csqlScenarios: readonly CsqlScenario[] = [datetimeEquality];

function admitted(doc: BlueprintDoc): BlueprintDoc {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings, null, 2));
	return doc;
}
