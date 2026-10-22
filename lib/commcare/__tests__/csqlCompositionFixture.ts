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
	type CaseType,
	plainColumn,
	proseText,
	type SearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	arith,
	dateCoerce,
	dateLiteral,
	datetimeCoerce,
	datetimeLiteral,
	double,
	type Expression,
	eq,
	exists,
	gte,
	ifExpr,
	input,
	isIn,
	literal,
	lt,
	lte,
	matchAll,
	matchNone,
	multiSelectAll,
	multiSelectAny,
	neq,
	not,
	prop,
	relationStep,
	sessionContext,
	sessionUser,
	subcasePath,
	term,
	today,
	whenInput,
	within,
} from "@/lib/domain/expression";
import {
	chosenCaseId,
	chosenCaseProperty,
} from "@/lib/domain/expression/chosenCase";
import type { DistanceUnit } from "@/lib/domain/expression/distance";
import type { SessionContextField } from "@/lib/domain/expression/types";
import { distanceSearchProperties } from "../distanceSearches";
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

/**
 * The device zones the family's Core class runs in, by the native runner's
 * label (`proof/native/families.py::ZONED_CLASSES`), and the zone each names.
 */
export const CSQL_DEVICE_ZONES = {
	utc: "UTC",
	kiritimati: "Pacific/Kiritimati",
	"new-york": "America/New_York",
} as const;
export type CsqlDeviceZone = keyof typeof CSQL_DEVICE_ZONES;

/** One sending of a search: what Core is answered with, and what it means. */
export interface CsqlSending {
	readonly id: string;
	/** Each search input's answer by its wire name; `null` leaves it unanswered. */
	readonly answers?: Readonly<Record<string, string | null>>;
	/**
	 * The session the search is sent from: the case chosen in each menu the
	 * entry passed through, by that menu's module UUID; the worker's user
	 * data fields by name; the session context values by field; and the
	 * instant the device's clock reads, for `today()` and `now()`.
	 */
	readonly session?: {
		readonly chosenCaseIds?: Readonly<Record<string, string>>;
		readonly user?: Readonly<Record<string, string>>;
		readonly context?: Readonly<Partial<Record<SessionContextField, string>>>;
		readonly clock?: string;
	};
	/**
	 * The device zone the search is sent in, when what it means depends on
	 * the zone (the worker's `today()`); absent, it means the same in every
	 * zone, and Core sends it in each.
	 */
	readonly zone?: CsqlDeviceZone;
	/**
	 * The composed query this sending means once Core has evaluated its
	 * runtime segments, runtime choices and obligations
	 * (`lib/commcare/csql/fold.ts::foldCsqlRuntime`'s answer): each runtime
	 * value a literal, each choice its chosen branch, a failed obligation
	 * `match-none`. Present exactly when the module's composed query reads a
	 * runtime value; absent, the composed query is already server-side.
	 */
	readonly folded?: Expression;
	/**
	 * The search inputs whose prompt validation holds this sending's answer
	 * on the device, by wire name: the worker cannot send the search until
	 * the answer changes, and its query still means `expected`.
	 */
	readonly refusedBy?: readonly string[];
	/** The case ids the search means, in any order. */
	readonly expected: readonly string[];
}

export interface CsqlSearch {
	/** A stable name for the search, also its module's name. */
	readonly id: string;
	/**
	 * The search reads related cases in a way HQ answers only with
	 * `CASE_SEARCH_RELATED_LOOKUPS` on (`filter_dsl.py::_require_related_lookups_flag`):
	 * without the flag, HQ refuses it.
	 */
	readonly relatedLookups?: true;
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
	const doc = scenario.doc();
	return {
		id: scenario.id,
		caseTypes: scenario.caseTypes,
		cases: scenario.cases,
		// The properties Nova's publish steps ask a person to type GPS in HQ's
		// data dictionary, the project configuration HQ's search measures
		// distance on.
		gpsProperties: distanceSearchProperties(doc).map(
			({ caseType, property }) => ({ caseType, property }),
		),
		// Module `i`'s UUID, so Core can name the menu a chosen case is chosen in.
		modules: doc.moduleOrder,
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
					folded: eq(
						prop(VISIT, "seen"),
						datetimeCoerce(term(literal("2026-01-02T09:30:00.000+05"))),
					),
					expected: atInstant,
				},
				{
					id: "zulu",
					answers: { [SEEN_INPUT]: "2026-01-02T04:30:00.000Z" },
					folded: eq(
						prop(VISIT, "seen"),
						datetimeCoerce(term(literal("2026-01-02T04:30:00.000Z"))),
					),
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

// --- The other constructs (§3.1–§3.12) -------------------------------------
//
// Each block below is one scenario in the same shape, answered by HQ's check,
// Core's class and Preview's Postgres check alike.

/** One module of a scenario document: a search over `caseType`. */
interface ScenarioModule {
	readonly name: string;
	readonly caseType: string;
	/** The module whose case the worker chooses before this module's list. */
	readonly parentModule?: string;
	readonly filter?: Expression;
	readonly inputs?: readonly SearchInputDef[];
}

/** A scenario's document: one Search-effective module per search, each with
 *  a follow-up form, as `datetimeEqualityDoc` builds its own. */
function scenarioDoc(
	scenario: string,
	appName: string,
	caseTypes: readonly CaseType[],
	modules: readonly ScenarioModule[],
): BlueprintDoc {
	const id = (name: string) => uuid(scenario, name);
	const doc = buildDoc({
		appId: `csql-${scenario}`,
		appName,
		caseTypes: [...caseTypes],
		modules: modules.map((module) => {
			const column = id(`${module.name}-name`);
			return {
				uuid: id(`${module.name}-module`),
				name: module.name,
				caseType: module.caseType,
				...(module.parentModule !== undefined && {
					parentCaseModuleUuid: id(`${module.parentModule}-module`),
				}),
				caseSearchConfig: {},
				caseListConfig: {
					columns: [plainColumn(column, "case_name", "Name")],
					listColumnOrder: [column],
					detailColumnOrder: [column],
					searchInputs: [...(module.inputs ?? [])],
					...(module.filter !== undefined && { filter: module.filter }),
				},
				forms: [
					{
						uuid: id(`${module.name}-review`),
						name: "Review",
						type: "followup" as const,
						fields: [
							f({
								kind: "text",
								uuid: id(`${module.name}-note`),
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

/** A fixed condition in an advanced Search input whose answer it never reads. */
function fixedRule(
	scenario: string,
	module: string,
	predicate: Expression,
): SearchInputDef[] {
	return [
		advancedSearchInputDef(
			uuid(scenario, `${module}-rule`),
			"rule",
			"Rule",
			"text",
			predicate,
		),
	];
}

const textProperty = (
	name: string,
	dataType?: CaseType["properties"][number]["data_type"],
) => ({
	name,
	label: proseText(name),
	...(dataType !== undefined && { data_type: dataType }),
});

const MODIFIED = "2026-01-01T08:00:00.000000Z";

// closed_on (§3.1): HQ's search reads open cases, so a case has no closed_on
// there, and only a negation keeps it (part 07 §5.5).

const CLOSING = "visit";
const closedOnCases: readonly CsqlCase[] = [
	{
		id: "csql-closed-open",
		type: CLOSING,
		name: "Open visit",
		properties: {},
		modified: MODIFIED,
	},
	{
		id: "csql-closed-closed",
		type: CLOSING,
		name: "Closed visit",
		properties: {},
		modified: "2026-02-01T08:00:00.000000Z",
		closed: true,
	},
];
const CLOSED_SINCE = term(datetimeLiteral("2026-01-01T00:00:00Z"));
const closedOnSearches = [
	["closed-since", gte(prop(CLOSING, "closed_on"), CLOSED_SINCE)],
	["not-closed-before", not(lt(prop(CLOSING, "closed_on"), CLOSED_SINCE))],
	[
		"closed-differs",
		neq(
			prop(CLOSING, "closed_on"),
			term(datetimeLiteral("2026-02-01T08:00:00Z")),
		),
	],
] as const;
export const closedOn: CsqlScenario = {
	id: "closed-on",
	caseTypes: [CLOSING],
	cases: closedOnCases,
	searches: [
		{ id: "closed-since", sendings: [{ id: "literal", expected: [] }] },
		{
			id: "not-closed-before",
			sendings: [{ id: "literal", expected: ["csql-closed-open"] }],
		},
		{
			id: "closed-differs",
			sendings: [{ id: "literal", expected: ["csql-closed-open"] }],
		},
	],
	doc: () =>
		scenarioDoc(
			"closed-on",
			"Closed visits",
			[{ name: CLOSING, properties: [textProperty("case_name")] }],
			closedOnSearches.map(([name, predicate]) => ({
				name,
				caseType: CLOSING,
				inputs: fixedRule("closed-on", name, predicate),
			})),
		),
};

// Case types (§3.2): the record's own type compared with a type name.

const HOME = "household";
const caseTypeCases: readonly CsqlCase[] = [
	{
		id: "csql-type-a",
		type: HOME,
		name: "A",
		properties: {},
		modified: MODIFIED,
	},
	{
		id: "csql-type-b",
		type: HOME,
		name: "B",
		properties: {},
		modified: MODIFIED,
	},
	{
		id: "csql-type-visit",
		type: "visit",
		name: "A's visit",
		properties: {},
		modified: MODIFIED,
		indices: [
			{
				identifier: "parent",
				caseType: HOME,
				caseId: "csql-type-a",
				relationship: "child",
			},
		],
	},
];
const recordType = term({ kind: "case-row-type" });
const caseType = (name: string) => term({ kind: "case-type", caseType: name });
const caseTypeSearches = [
	["is-household", eq(recordType, caseType(HOME))],
	["not-household", neq(recordType, caseType(HOME))],
	["not-visit", neq(recordType, caseType("visit"))],
	["household-or-visit", isIn(recordType, literal(HOME), literal("visit"))],
	// HQ's `subcase-exists('parent', @case_type = 'visit')`.
	[
		"has-visit",
		exists(subcasePath("parent"), eq(recordType, caseType("visit"))),
	],
] as const;
export const caseTypes: CsqlScenario = {
	id: "case-types",
	caseTypes: [HOME, "visit"],
	cases: caseTypeCases,
	searches: [
		{
			id: "is-household",
			sendings: [{ id: "literal", expected: ["csql-type-a", "csql-type-b"] }],
		},
		{ id: "not-household", sendings: [{ id: "literal", expected: [] }] },
		{
			id: "not-visit",
			sendings: [{ id: "literal", expected: ["csql-type-a", "csql-type-b"] }],
		},
		{
			id: "household-or-visit",
			sendings: [{ id: "literal", expected: ["csql-type-a", "csql-type-b"] }],
		},
		{
			id: "has-visit",
			relatedLookups: true,
			sendings: [{ id: "literal", expected: ["csql-type-a"] }],
		},
	],
	doc: () =>
		scenarioDoc(
			"case-types",
			"Record types",
			[
				{ name: HOME, properties: [textProperty("case_name")] },
				{
					name: "visit",
					parent_type: HOME,
					relationship: "child",
					properties: [textProperty("case_name")],
				},
			],
			caseTypeSearches.map(([name, predicate]) => ({
				name,
				caseType: HOME,
				inputs: fixedRule("case-types", name, predicate),
			})),
		),
};

// Epoch coercions (§3.5): day 19000 is 2022-01-08.

const EVENT = "event";
const epochCases: readonly CsqlCase[] = [
	{
		id: "csql-epoch-on",
		type: EVENT,
		name: "On the day",
		properties: { day: "2022-01-08", at: "2022-01-08T12:00:00.000Z" },
		modified: MODIFIED,
	},
	{
		id: "csql-epoch-before",
		type: EVENT,
		name: "The day before",
		properties: { day: "2022-01-07", at: "2022-01-08T11:00:00.000Z" },
		modified: MODIFIED,
	},
	{
		id: "csql-epoch-none",
		type: EVENT,
		name: "No day",
		properties: {},
		modified: MODIFIED,
	},
];
const epochSearches = [
	["day-19000", eq(prop(EVENT, "day"), dateCoerce(term(literal(19000))))],
	["day-after-epoch", gte(prop(EVENT, "day"), dateCoerce(term(literal(-1))))],
	["at-noon", gte(prop(EVENT, "at"), datetimeCoerce(term(literal(19000.5))))],
] as const;
const DAY_INPUT = "day_number";
const dayAnswer = uuid("epoch-days", "day-input");
/** A day number the device works out from the worker's answer (days after
 * day 18990), read at run time: `date(number(…))`. */
const runtimeDaySearch: ScenarioModule = {
	name: "runtime-day",
	caseType: EVENT,
	inputs: [
		advancedSearchInputDef(
			dayAnswer,
			DAY_INPUT,
			"Day number",
			"text",
			whenInput(
				input(dayAnswer),
				eq(
					prop(EVENT, "day"),
					dateCoerce(
						arith("+", term(literal(18990)), double(term(input(dayAnswer)))),
					),
				),
			),
		),
	],
};
export const epochDays: CsqlScenario = {
	id: "epoch-days",
	caseTypes: [EVENT],
	cases: epochCases,
	searches: [
		{
			id: "day-19000",
			sendings: [{ id: "literal", expected: ["csql-epoch-on"] }],
		},
		{
			id: "day-after-epoch",
			sendings: [
				{ id: "literal", expected: ["csql-epoch-on", "csql-epoch-before"] },
			],
		},
		{
			id: "at-noon",
			sendings: [{ id: "literal", expected: ["csql-epoch-on"] }],
		},
		{
			id: "runtime-day",
			sendings: [
				{
					id: "whole",
					answers: { [DAY_INPUT]: "10" },
					folded: eq(prop(EVENT, "day"), dateCoerce(term(literal(19000)))),
					expected: ["csql-epoch-on"],
				},
				// `epoch-days-not-whole`: a day number with a fraction finds nothing.
				{
					id: "fraction",
					answers: { [DAY_INPUT]: "1.5" },
					folded: matchNone(),
					expected: [],
				},
			],
		},
	],
	doc: () =>
		scenarioDoc(
			"epoch-days",
			"Event days",
			[
				{
					name: EVENT,
					properties: [
						textProperty("case_name"),
						textProperty("day", "date"),
						textProperty("at", "datetime"),
					],
				},
			],
			[
				...epochSearches.map(([name, predicate]) => ({
					name,
					caseType: EVENT,
					inputs: fixedRule("epoch-days", name, predicate),
				})),
				runtimeDaySearch,
			],
		),
};

// A list of values (§3.6), held for import: HQ's exact any-of.

const ITEM = "item";
const valueListCases: readonly CsqlCase[] = [
	{
		id: "csql-list-red",
		type: ITEM,
		name: "Red",
		properties: { color: "red" },
		modified: MODIFIED,
	},
	{
		id: "csql-list-quote",
		type: ITEM,
		name: "Quote",
		properties: { color: "it's" },
		modified: MODIFIED,
	},
	{
		id: "csql-list-blue",
		type: ITEM,
		name: "Blue",
		properties: { color: "blue" },
		modified: MODIFIED,
	},
	{
		id: "csql-list-none",
		type: ITEM,
		name: "None",
		properties: {},
		modified: MODIFIED,
	},
];
const COLORS: Expression = {
	kind: "value-list",
	items: [term(literal("red")), term(literal("it's"))],
};
/** The worker's two colors, read at run time. */
const WORKER_COLORS: Expression = {
	kind: "value-list",
	items: [term(sessionUser("first_color")), term(sessionUser("second_color"))],
};
const workerColors = (first: string, second: string) => ({
	user: { first_color: first, second_color: second },
});
export const valueList: CsqlScenario = {
	id: "value-list",
	caseTypes: [ITEM],
	cases: valueListCases,
	searches: [
		{
			id: "in-list",
			sendings: [
				{ id: "literal", expected: ["csql-list-red", "csql-list-quote"] },
			],
		},
		{
			id: "not-in-list",
			sendings: [
				{ id: "literal", expected: ["csql-list-blue", "csql-list-none"] },
			],
		},
		{
			id: "in-worker-colors",
			sendings: [
				{
					id: "red-blue",
					session: workerColors("red", "blue"),
					folded: eq(prop(ITEM, "color"), {
						kind: "value-list",
						items: [term(literal("red")), term(literal("blue"))],
					}),
					expected: ["csql-list-red", "csql-list-blue"],
				},
				// An item holding `"` cannot be written into HQ's list: the search
				// finds nothing.
				{
					id: "double-quote",
					session: workerColors('say "hi"', "blue"),
					folded: matchNone(),
					expected: [],
				},
			],
		},
	],
	doc: () =>
		scenarioDoc(
			"value-list",
			"Colors",
			[
				{
					name: ITEM,
					properties: [textProperty("case_name"), textProperty("color")],
				},
			],
			(
				[
					["in-list", eq(prop(ITEM, "color"), COLORS)],
					["not-in-list", neq(prop(ITEM, "color"), COLORS)],
					["in-worker-colors", eq(prop(ITEM, "color"), WORKER_COLORS)],
				] as const
			).map(([name, predicate]) => ({
				name,
				caseType: ITEM,
				inputs: fixedRule("value-list", name, predicate),
			})),
		),
};

// Runtime selected values (§3.7): a runtime value is a list of tokens.

const TAGGED = "client";
const TAGS_INPUT = "tags";
const selectedCases: readonly CsqlCase[] = [
	{
		id: "csql-tags-a",
		type: TAGGED,
		name: "A",
		properties: { tags: "a" },
		modified: MODIFIED,
	},
	{
		id: "csql-tags-ab",
		type: TAGGED,
		name: "AB",
		properties: { tags: "a b" },
		modified: MODIFIED,
	},
	{
		id: "csql-tags-c",
		type: TAGGED,
		name: "C",
		properties: { tags: "c" },
		modified: MODIFIED,
	},
	{
		id: "csql-tags-none",
		type: TAGGED,
		name: "None",
		properties: {},
		modified: MODIFIED,
	},
];
const allTagged = selectedCases.map((row) => row.id);
const tags = prop(TAGGED, "tags");
function selectedSearch(quantifier: "any" | "all"): ScenarioModule {
	const answer = uuid("runtime-selected", `${quantifier}-input`);
	return {
		name: `${quantifier}-of-answer`,
		caseType: TAGGED,
		inputs: [
			advancedSearchInputDef(
				answer,
				TAGS_INPUT,
				"Tags",
				"text",
				whenInput(input(answer), {
					kind: "multi-select-contains",
					property: tags,
					quantifier,
					values: [term(input(answer))],
				}),
			),
		],
	};
}
export const runtimeSelected: CsqlScenario = {
	id: "runtime-selected",
	caseTypes: [TAGGED],
	cases: selectedCases,
	searches: [
		{
			id: "any-of-answer",
			sendings: [
				{
					id: "two-tokens",
					answers: { [TAGS_INPUT]: "a b" },
					folded: multiSelectAny(tags, literal("a"), literal("b")),
					expected: ["csql-tags-a", "csql-tags-ab"],
				},
				{
					id: "unanswered",
					answers: { [TAGS_INPUT]: null },
					folded: matchAll(),
					expected: allTagged,
				},
				{
					id: "double-quote",
					answers: { [TAGS_INPUT]: 'a"b' },
					folded: multiSelectAny(tags, literal('a"b')),
					expected: [],
				},
			],
		},
		{
			id: "all-of-answer",
			sendings: [
				{
					id: "two-tokens",
					answers: { [TAGS_INPUT]: "a b" },
					folded: multiSelectAll(tags, literal("a"), literal("b")),
					expected: ["csql-tags-ab"],
				},
			],
		},
	],
	doc: () =>
		scenarioDoc(
			"runtime-selected",
			"Tagged clients",
			[
				{
					name: TAGGED,
					properties: [
						textProperty("case_name"),
						textProperty("tags", "multi_select"),
					],
				},
			],
			[selectedSearch("any"), selectedSearch("all")],
		),
};

// Distance units and runtime distance operands (§3.8): Near is about 111 m
// from the center and Far about 1,112 m.

const SITE = "site";
const NEAR = "csql-site-near";
const FAR = "csql-site-far";
const siteCases: readonly CsqlCase[] = [
	{
		id: NEAR,
		type: SITE,
		name: "Near",
		properties: { gps: "0.001 0" },
		modified: MODIFIED,
	},
	{
		id: FAR,
		type: SITE,
		name: "Far",
		properties: { gps: "0.01 0" },
		modified: MODIFIED,
	},
	{
		id: "csql-site-unplaced",
		type: SITE,
		name: "Unplaced",
		properties: {},
		modified: MODIFIED,
	},
];
const gps = prop(SITE, "gps");
const CENTER = term(literal("0 0"));
/** Each unit's radius between Near and Far, and one taking both. */
const UNIT_RADII: readonly (readonly [
	DistanceUnit,
	number,
	readonly string[],
])[] = [
	["miles", 0.1, [NEAR]],
	["yards", 250, [NEAR]],
	["feet", 600, [NEAR]],
	["inch", 8000, [NEAR]],
	["kilometers", 0.2, [NEAR]],
	["meters", 200, [NEAR]],
	["centimeters", 20000, [NEAR]],
	["millimeters", 200000, [NEAR]],
	["nauticalmiles", 0.1, [NEAR]],
	["kilometers", 2, [NEAR, FAR]],
];
const RADIUS_INPUT = "radius";
const UNIT_INPUT = "unit";
const radiusAnswer = uuid("distance-units", "radius-input");
const unitAnswer = uuid("distance-units", "unit-input");
const radiusSearch: ScenarioModule = {
	name: "runtime-radius",
	caseType: SITE,
	inputs: [
		advancedSearchInputDef(
			radiusAnswer,
			RADIUS_INPUT,
			"Radius",
			"text",
			whenInput(
				input(radiusAnswer),
				within(gps, CENTER, double(term(input(radiusAnswer))), "meters"),
			),
		),
	],
};
const unitSearch: ScenarioModule = {
	name: "runtime-unit",
	caseType: SITE,
	inputs: [
		advancedSearchInputDef(
			unitAnswer,
			UNIT_INPUT,
			"Unit",
			"text",
			whenInput(
				input(unitAnswer),
				within(gps, CENTER, 200, term(input(unitAnswer))),
			),
		),
	],
};
export const distanceUnits: CsqlScenario = {
	id: "distance-units",
	caseTypes: [SITE],
	cases: siteCases,
	searches: [
		...UNIT_RADII.map(([unit, radius, expected]) => ({
			id: `${radius}-${unit}`,
			sendings: [{ id: "literal", expected }],
		})),
		{
			id: "runtime-radius",
			sendings: [
				{
					id: "200",
					answers: { [RADIUS_INPUT]: "200" },
					folded: within(gps, CENTER, 200, "meters"),
					expected: [NEAR],
				},
				{
					id: "2000",
					answers: { [RADIUS_INPUT]: "2000" },
					folded: within(gps, CENTER, 2000, "meters"),
					expected: [NEAR, FAR],
				},
				// `positive-number`: the search finds nothing.
				{
					id: "zero",
					answers: { [RADIUS_INPUT]: "0" },
					folded: matchNone(),
					expected: [],
				},
				{
					id: "word",
					answers: { [RADIUS_INPUT]: "abc" },
					folded: matchNone(),
					expected: [],
				},
			],
		},
		{
			id: "runtime-unit",
			sendings: [
				{
					id: "meters",
					answers: { [UNIT_INPUT]: "meters" },
					folded: within(gps, CENTER, 200, "meters"),
					expected: [NEAR],
				},
				{
					id: "kilometers",
					answers: { [UNIT_INPUT]: "kilometers" },
					folded: within(gps, CENTER, 200, "kilometers"),
					expected: [NEAR, FAR],
				},
				// `distance-unit`: the search finds nothing.
				{
					id: "parsecs",
					answers: { [UNIT_INPUT]: "parsecs" },
					refusedBy: [UNIT_INPUT],
					folded: matchNone(),
					expected: [],
				},
			],
		},
	],
	doc: () =>
		scenarioDoc(
			"distance-units",
			"Sites",
			[
				{
					name: SITE,
					properties: [
						textProperty("case_name"),
						textProperty("gps", "geopoint"),
					],
				},
			],
			[
				...UNIT_RADII.map(([unit, radius]) => {
					const name = `${radius}-${unit}`;
					return {
						name,
						caseType: SITE,
						inputs: fixedRule(
							"distance-units",
							name,
							within(gps, CENTER, radius, unit),
						),
					};
				}),
				radiusSearch,
				unitSearch,
			],
		),
};

// Runtime choice among clauses (§3.10), and a row-reading `if`.

const PERSON = "person";
const MODE_INPUT = "mode";
const modeAnswer = uuid("runtime-choice", "mode-input");
const personCases: readonly CsqlCase[] = [
	{
		id: "csql-person-young",
		type: PERSON,
		name: "Young",
		properties: { age: "10" },
		modified: MODIFIED,
	},
	{
		id: "csql-person-adult",
		type: PERSON,
		name: "Adult",
		properties: { age: "30" },
		modified: MODIFIED,
	},
	{
		id: "csql-person-unknown",
		type: PERSON,
		name: "Unknown",
		properties: {},
		modified: MODIFIED,
	},
];
const age = prop(PERSON, "age");
const adult = gte(age, term(literal(18)));
const child = lt(age, term(literal(18)));
const LIMIT_INPUT = "limit";
const SINCE_INPUT = "since";
const pickAnswer = uuid("runtime-choice", "pick-input");
const limitAnswer = uuid("runtime-choice", "limit-input");
const sinceAnswer = uuid("runtime-choice", "since-input");
/** 2026-01-02 04:30 UTC, the instant "by-time" compares the answer with. */
const CHOICE_INSTANT = term(datetimeLiteral("2026-01-02T04:30:00Z"));
export const runtimeChoice: CsqlScenario = {
	id: "runtime-choice",
	caseTypes: [PERSON],
	cases: personCases,
	searches: [
		{
			id: "by-mode",
			sendings: [
				{
					id: "adults",
					answers: { [MODE_INPUT]: "adults" },
					folded: adult,
					expected: ["csql-person-adult"],
				},
				{
					id: "children",
					answers: { [MODE_INPUT]: "children" },
					folded: child,
					expected: ["csql-person-young"],
				},
				// An unanswered input reads '' on a device, so the condition is false.
				{
					id: "unanswered",
					answers: { [MODE_INPUT]: null },
					folded: child,
					expected: ["csql-person-young"],
				},
			],
		},
		{
			id: "by-pick-or-limit",
			sendings: [
				// A field left empty is never sent as a typed blank: Web Apps leaves
				// it out of the request (query.js::encodeValue, ::getAnswers) and
				// Android answers it with null (QueryRequestUiController.kt
				// ::answerUserPrompt), so the limit is unanswered. The chosen branch
				// then reads no limit and narrows nothing.
				{
					id: "adults-limit-unanswered",
					answers: { [MODE_INPUT]: "adults", [LIMIT_INPUT]: null },
					folded: adult,
					expected: ["csql-person-adult"],
				},
				{
					id: "under-limit-unanswered",
					answers: { [MODE_INPUT]: "under", [LIMIT_INPUT]: null },
					folded: matchAll(),
					expected: personCases.map((row) => row.id),
				},
				{
					id: "under-limit",
					answers: { [MODE_INPUT]: "under", [LIMIT_INPUT]: "20" },
					folded: lt(age, term(literal(20))),
					expected: ["csql-person-young"],
				},
			],
		},
		// A date and time ordering in the condition, its answer written at
		// +05:30, which the device orders as an instant in its own zone.
		{
			id: "by-time",
			sendings: [
				{
					id: "at-instant",
					answers: { [SINCE_INPUT]: "2026-01-02T10:00:00.000+05:30" },
					folded: adult,
					expected: ["csql-person-adult"],
				},
				{
					id: "a-minute-before",
					answers: { [SINCE_INPUT]: "2026-01-02T09:59:00.000+05:30" },
					folded: child,
					expected: ["csql-person-young"],
				},
			],
		},
		{
			id: "row-if",
			sendings: [{ id: "literal", expected: ["csql-person-adult"] }],
		},
		// A row whose condition is unknown takes the else branch.
		{
			id: "row-if-else",
			sendings: [
				{
					id: "literal",
					expected: ["csql-person-young", "csql-person-unknown"],
				},
			],
		},
	],
	doc: () =>
		scenarioDoc(
			"runtime-choice",
			"People",
			[
				{
					name: PERSON,
					properties: [textProperty("case_name"), textProperty("age", "int")],
				},
			],
			[
				{
					name: "by-mode",
					caseType: PERSON,
					inputs: [
						advancedSearchInputDef(
							modeAnswer,
							MODE_INPUT,
							"Mode",
							"text",
							ifExpr(
								eq(term(input(modeAnswer)), term(literal("adults"))),
								adult,
								child,
							),
						),
					],
				},
				{
					name: "by-pick-or-limit",
					caseType: PERSON,
					inputs: [
						advancedSearchInputDef(
							pickAnswer,
							MODE_INPUT,
							"Mode",
							"text",
							ifExpr(
								eq(term(input(pickAnswer)), term(literal("adults"))),
								adult,
								whenInput(
									input(limitAnswer),
									lt(age, double(term(input(limitAnswer)))),
								),
							),
						),
						advancedSearchInputDef(
							limitAnswer,
							LIMIT_INPUT,
							"Age limit",
							"text",
							matchAll(),
						),
					],
				},
				{
					name: "by-time",
					caseType: PERSON,
					inputs: [
						advancedSearchInputDef(
							sinceAnswer,
							SINCE_INPUT,
							"Since",
							"text",
							ifExpr(
								gte(datetimeCoerce(term(input(sinceAnswer))), CHOICE_INSTANT),
								adult,
								child,
							),
						),
					],
				},
				{
					name: "row-if",
					caseType: PERSON,
					inputs: fixedRule(
						"runtime-choice",
						"row-if",
						ifExpr(adult, matchAll(), matchNone()),
					),
				},
				{
					name: "row-if-else",
					caseType: PERSON,
					inputs: fixedRule(
						"runtime-choice",
						"row-if-else",
						ifExpr(adult, matchNone(), matchAll()),
					),
				},
			],
		),
};

// The case chosen in an earlier menu (§3.9) and the flag-free ancestor case id
// (§3.12): "Members by household" narrows its search to the chosen
// household's children; "Members by village" lists, and searches for, the
// members whose home village is the chosen household's. Each Members module
// selects its household in "Households" first.

const HOUSEHOLD = "household";
const MEMBER = "member";
const NORTH = "csql-household-north";
const SOUTH = "csql-household-south";
const chosenCaseCases: readonly CsqlCase[] = [
	{
		id: NORTH,
		type: HOUSEHOLD,
		name: "North house",
		properties: { village: "North" },
		modified: MODIFIED,
	},
	{
		id: SOUTH,
		type: HOUSEHOLD,
		name: "South house",
		properties: { village: "South" },
		modified: MODIFIED,
	},
	...(
		[
			["csql-member-north-north", NORTH, "North"],
			["csql-member-north-south", NORTH, "South"],
			["csql-member-south-north", SOUTH, "North"],
			["csql-member-south-south", SOUTH, "South"],
		] as const
	).map(
		([id, household, village]): CsqlCase => ({
			id,
			type: MEMBER,
			name: id,
			properties: { home_village: village },
			modified: MODIFIED,
			indices: [
				{
					identifier: "parent",
					caseType: HOUSEHOLD,
					caseId: household,
					relationship: "child",
				},
			],
		}),
	),
];
const householdsModule = uuid("chosen-case", "Households-module");
const chosenHousehold = chosenCaseId(householdsModule);
const chosenVillage = chosenCaseProperty(
	householdsModule,
	HOUSEHOLD,
	"village",
);
const parentId = prop(MEMBER, "case_id", ancestorPath(relationStep("parent")));
const homeVillage = prop(MEMBER, "home_village");
const choosing = (household: string) => ({
	chosenCaseIds: { [householdsModule]: household },
});
export const chosenCase: CsqlScenario = {
	id: "chosen-case",
	caseTypes: [HOUSEHOLD, MEMBER],
	cases: chosenCaseCases,
	searches: [
		{ id: "Households", sendings: [{ id: "all", expected: [NORTH, SOUTH] }] },
		{
			id: "Members by household",
			sendings: [
				{
					id: "north",
					session: choosing(NORTH),
					folded: eq(parentId, term(literal(NORTH))),
					expected: ["csql-member-north-north", "csql-member-north-south"],
				},
				{
					id: "south",
					session: choosing(SOUTH),
					folded: eq(parentId, term(literal(SOUTH))),
					expected: ["csql-member-south-north", "csql-member-south-south"],
				},
			],
		},
		{
			id: "Members by household and village",
			sendings: [
				{
					id: "north",
					session: choosing(NORTH),
					folded: and(
						eq(parentId, term(literal(NORTH))),
						eq(homeVillage, term(literal("North"))),
					),
					expected: ["csql-member-north-north"],
				},
				{
					id: "south",
					session: choosing(SOUTH),
					folded: and(
						eq(parentId, term(literal(SOUTH))),
						eq(homeVillage, term(literal("South"))),
					),
					expected: ["csql-member-south-south"],
				},
			],
		},
		{
			id: "Members by village",
			sendings: [
				{
					id: "north",
					session: choosing(NORTH),
					folded: eq(homeVillage, term(literal("North"))),
					expected: ["csql-member-north-north", "csql-member-south-north"],
				},
				{
					id: "south",
					session: choosing(SOUTH),
					folded: eq(homeVillage, term(literal("South"))),
					expected: ["csql-member-north-south", "csql-member-south-south"],
				},
			],
		},
	],
	doc: () =>
		scenarioDoc(
			"chosen-case",
			"Households",
			[
				{
					name: HOUSEHOLD,
					properties: [textProperty("case_name"), textProperty("village")],
				},
				{
					name: MEMBER,
					parent_type: HOUSEHOLD,
					relationship: "child",
					properties: [textProperty("case_name"), textProperty("home_village")],
				},
			],
			[
				{ name: "Households", caseType: HOUSEHOLD },
				{
					name: "Members by household",
					caseType: MEMBER,
					parentModule: "Households",
					inputs: fixedRule(
						"chosen-case",
						"Members by household",
						eq(parentId, chosenHousehold),
					),
				},
				{
					name: "Members by household and village",
					caseType: MEMBER,
					parentModule: "Households",
					inputs: fixedRule(
						"chosen-case",
						"Members by household and village",
						and(eq(parentId, chosenHousehold), eq(homeVillage, chosenVillage)),
					),
				},
				{
					name: "Members by village",
					caseType: MEMBER,
					parentModule: "Households",
					filter: eq(homeVillage, chosenVillage),
				},
			],
		),
};

// A selected value read from the chosen case (§3.6, §3.9), the way a device
// reaches a blank comparand: the chosen group's "wanted" saved blank. A typed
// blank answer is not one, since no device sends it (Web Apps leaves an empty
// field out of its request, query.js::encodeValue; Android answers it with
// null, QueryRequestUiController.kt::answerUserPrompt).

const GROUP = "tag_group";
const GROUPED = "grouped_item";
const WANTS_AB = "csql-group-wants-ab";
const WANTS_BLANK = "csql-group-wants-blank";
const WANTS_UNSET = "csql-group-wants-unset";
const chosenBlankCases: readonly CsqlCase[] = [
	{
		id: WANTS_AB,
		type: GROUP,
		name: "Wants a or b",
		properties: { wanted: "a b" },
		modified: MODIFIED,
	},
	{
		id: WANTS_BLANK,
		type: GROUP,
		name: "Wants nothing yet",
		properties: { wanted: "" },
		modified: MODIFIED,
	},
	// Never given a "wanted": the device's casedb holds no such property.
	{
		id: WANTS_UNSET,
		type: GROUP,
		name: "Wants not asked",
		properties: {},
		modified: MODIFIED,
	},
	...(
		[
			["csql-grouped-a", "a"],
			["csql-grouped-c", "c"],
			["csql-grouped-none", null],
		] as const
	).map(
		([id, tags]): CsqlCase => ({
			id,
			type: GROUPED,
			name: id,
			properties: tags === null ? {} : { tags },
			modified: MODIFIED,
			indices: [
				{
					identifier: "parent",
					caseType: GROUP,
					caseId: WANTS_AB,
					relationship: "child",
				},
			],
		}),
	),
];
const groupsModule = uuid("chosen-blank", "Groups-module");
const groupedTags = prop(GROUPED, "tags");
const choosingGroup = (group: string) => ({
	chosenCaseIds: { [groupsModule]: group },
});
export const chosenBlank: CsqlScenario = {
	id: "chosen-blank",
	caseTypes: [GROUP, GROUPED],
	cases: chosenBlankCases,
	searches: [
		{
			id: "Groups",
			sendings: [{ id: "all", expected: [WANTS_AB, WANTS_BLANK, WANTS_UNSET] }],
		},
		{
			id: "Items the group wants",
			sendings: [
				{
					id: "wants-ab",
					session: choosingGroup(WANTS_AB),
					folded: multiSelectAny(groupedTags, literal("a"), literal("b")),
					expected: ["csql-grouped-a"],
				},
				// A blank selected value names no choice: the search finds nothing.
				{
					id: "wants-blank",
					session: choosingGroup(WANTS_BLANK),
					folded: matchNone(),
					expected: [],
				},
				// A property never written reads blank too.
				{
					id: "wants-unset",
					session: choosingGroup(WANTS_UNSET),
					folded: matchNone(),
					expected: [],
				},
			],
		},
	],
	doc: () =>
		scenarioDoc(
			"chosen-blank",
			"Tag groups",
			[
				{
					name: GROUP,
					properties: [textProperty("case_name"), textProperty("wanted")],
				},
				{
					name: GROUPED,
					parent_type: GROUP,
					relationship: "child",
					properties: [
						textProperty("case_name"),
						textProperty("tags", "multi_select"),
					],
				},
			],
			[
				{ name: "Groups", caseType: GROUP },
				{
					name: "Items the group wants",
					caseType: GROUPED,
					parentModule: "Groups",
					inputs: fixedRule("chosen-blank", "Items the group wants", {
						kind: "multi-select-contains",
						property: groupedTags,
						quantifier: "any",
						values: [chosenCaseProperty(groupsModule, GROUP, "wanted")],
					}),
				},
			],
		),
};

// The worker's day (§3.4): `today()` is the device's date, which Core writes
// into the query, so HQ never reads its own day or the project's zone. At
// 2026-01-02 11:00 UTC it is still the 2nd in UTC and New York and already
// the 3rd on Kiritimati.

const TASK = "task";
/** The instant the device's clock reads when the worker searches. */
const TODAY_CLOCK = "2026-01-02T11:00:00Z";
const taskCases: readonly CsqlCase[] = (
	[
		["csql-task-first", "2026-01-01"],
		["csql-task-second", "2026-01-02"],
		["csql-task-third", "2026-01-03"],
	] as const
).map(([id, due]) => ({
	id,
	type: TASK,
	name: id,
	properties: { due },
	modified: MODIFIED,
}));
const due = prop(TASK, "due");
/** One sending per device zone, each meaning that zone's date: the query
 * Core's evaluation leaves holds that date as a literal. */
const dueSendings = (
	query: (date: Expression) => Expression,
	expected: (date: string) => readonly string[],
): CsqlSending[] =>
	(
		[
			["utc", "2026-01-02"],
			["kiritimati", "2026-01-03"],
			["new-york", "2026-01-02"],
		] as const
	).map(([zone, date]) => ({
		id: zone,
		zone,
		session: { clock: TODAY_CLOCK },
		folded: query(term(dateLiteral(date))),
		expected: expected(date),
	}));
const byDue = (keep: (due: string) => boolean) =>
	taskCases
		.filter((row) => keep(row.properties.due ?? ""))
		.map((row) => row.id);
export const workerDay: CsqlScenario = {
	id: "worker-day",
	caseTypes: [TASK],
	cases: taskCases,
	searches: [
		{
			id: "due-today",
			sendings: dueSendings(
				(date) => eq(due, date),
				(date) => byDue((due) => due === date),
			),
		},
		{
			id: "due-by-today",
			sendings: dueSendings(
				(date) => lte(due, date),
				(date) => byDue((due) => due <= date),
			),
		},
	],
	doc: () =>
		scenarioDoc(
			"worker-day",
			"Tasks",
			[
				{
					name: TASK,
					properties: [textProperty("case_name"), textProperty("due", "date")],
				},
			],
			(
				[
					["due-today", eq(due, today())],
					["due-by-today", lte(due, today())],
				] as const
			).map(([name, predicate]) => ({
				name,
				caseType: TASK,
				inputs: fixedRule("worker-day", name, predicate),
			})),
		),
};

// Worker values (§3.9): a search narrowed by the worker's own user data and
// by the session's user id.

const CLIENT = "client";
const clientCases: readonly CsqlCase[] = (
	[
		["csql-client-mine-north", "worker-1", "North"],
		["csql-client-mine-south", "worker-1", "South"],
		["csql-client-other-north", "worker-2", "North"],
	] as const
).map(([id, owner, region]) => ({
	id,
	type: CLIENT,
	name: id,
	properties: { assigned_to: owner, region },
	modified: MODIFIED,
}));
const worker = (region: string) => ({
	user: { region },
	context: { userid: "worker-1" },
});
export const workerValues: CsqlScenario = {
	id: "worker-values",
	caseTypes: [CLIENT],
	cases: clientCases,
	searches: [
		{
			id: "in-my-region",
			sendings: [
				{
					id: "north",
					session: worker("North"),
					folded: eq(prop(CLIENT, "region"), term(literal("North"))),
					expected: ["csql-client-mine-north", "csql-client-other-north"],
				},
				{
					id: "south",
					session: worker("South"),
					folded: eq(prop(CLIENT, "region"), term(literal("South"))),
					expected: ["csql-client-mine-south"],
				},
			],
		},
		{
			id: "assigned-to-me",
			sendings: [
				{
					id: "worker-1",
					session: worker("North"),
					folded: eq(prop(CLIENT, "assigned_to"), term(literal("worker-1"))),
					expected: ["csql-client-mine-north", "csql-client-mine-south"],
				},
			],
		},
	],
	doc: () =>
		scenarioDoc(
			"worker-values",
			"Clients",
			[
				{
					name: CLIENT,
					properties: [
						textProperty("case_name"),
						textProperty("assigned_to"),
						textProperty("region"),
					],
				},
			],
			(
				[
					[
						"in-my-region",
						eq(prop(CLIENT, "region"), term(sessionUser("region"))),
					],
					[
						"assigned-to-me",
						eq(prop(CLIENT, "assigned_to"), term(sessionContext("userid"))),
					],
				] as const
			).map(([name, predicate]) => ({
				name,
				caseType: CLIENT,
				inputs: fixedRule("worker-values", name, predicate),
			})),
		),
};

/** Every scenario, in the order the family writes and checks them. */
export const csqlScenarios: readonly CsqlScenario[] = [
	datetimeEquality,
	closedOn,
	caseTypes,
	epochDays,
	valueList,
	runtimeSelected,
	distanceUnits,
	runtimeChoice,
	chosenCase,
	chosenBlank,
	workerDay,
	workerValues,
];

function admitted(doc: BlueprintDoc): BlueprintDoc {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings, null, 2));
	return doc;
}
