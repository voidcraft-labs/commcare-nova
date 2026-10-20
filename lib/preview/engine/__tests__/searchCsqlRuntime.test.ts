import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseRow } from "@/lib/case-store";
import { chosenCase } from "@/lib/commcare/__tests__/csqlCompositionFixture";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	advancedSearchInputDef,
	type BlueprintDoc,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import {
	eq,
	gte,
	ifExpr,
	input,
	literal,
	matchesPattern,
	prop,
	tableColumn,
	tableLookup,
	term,
	today,
	whenInput,
	within,
} from "@/lib/domain/expression/builders";
import { chosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import type { Expression } from "@/lib/domain/expression/types";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { evaluateAsync } from "../../xpath/asyncEvaluator";
import { xpathToString } from "../../xpath/coerce";
import { evaluate } from "../../xpath/evaluator";
import { invokeGeneratedJavaRosaFunction } from "../../xpath/generatedJavaRosaFunctions";
import {
	formDisplayVisibility,
	navigationSelectedCase,
} from "../displayConditionEvaluation";
import { caseListStepSession } from "../entrySessionData";
import { previewExpressionContext } from "../expressionContext";
import type { PreviewSearchSessionValues } from "../identity";
import { type PreviewLookupData, previewLookupData } from "../lookupEvaluation";
import {
	evaluateSearchCsqlRuntime,
	foldSearchCsql,
	parseSearchCsqlRuntimeWire,
	type SearchCsqlDeviceEvaluator,
	SearchCsqlRuntimeError,
	type SearchCsqlRuntimeWire,
	searchCsqlForRead,
	searchCsqlRejected,
} from "../searchCsqlRuntime";
import type { CaseDatabaseSnapshot } from "../xpathInstances";

// Preview's search path end to end, short of Postgres: the browser composes
// the module's search, evaluates its runtime pieces over the Search screen's
// world, and the server folds the rows with them. What reaches the store
// holds no runtime leaf.

const SESSION: PreviewSearchSessionValues = {
	context: {},
	user: {},
	userPropertySlugs: {},
};
const NORTH = "csql-household-north";
const households = testUuid("csql-chosen-case-Households-module");

function moduleNamed(doc: BlueprintDoc, name: string): Uuid {
	const found = Object.values(doc.modules).find((mod) => mod.name === name);
	if (found === undefined) throw new Error(`No module ${name}.`);
	return found.uuid;
}

function row(
	caseId: string,
	caseType: string,
	properties: Record<string, string>,
): CaseRow {
	return {
		case_id: caseId,
		app_id: "app",
		case_type: caseType,
		owner_id: "worker-1",
		status: "open",
		case_name: caseId,
		external_id: null,
		opened_on: null,
		closed_on: null,
		modified_on: null,
		parent_case_id: null,
		properties,
	} as unknown as CaseRow;
}

const device: CaseDatabaseSnapshot = {
	rows: [row(NORTH, "household", { village: "North" })],
	indices: [],
};
const choosingNorth: Record<string, PreviewMenuCaseSelection> = {
	[households]: {
		caseType: "household",
		cases: [{ caseId: NORTH, caseName: "North house" }],
	},
};

/** The search as the server compiles it, from what the browser sent. */
async function searched(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	answers: Record<string, string> = {},
	lookup?: PreviewLookupData,
	onDevice?: SearchCsqlDeviceEvaluator,
): Promise<{
	readonly query: Expression | undefined;
	readonly rejected: boolean;
	readonly refusal: SearchCsqlRuntimeWire["refusal"];
	readonly unevaluated: boolean;
}> {
	const caseListConfig = doc.modules[moduleUuid]?.caseListConfig;
	if (caseListConfig === undefined) throw new Error("No case list.");
	const step = caseListStepSession(doc, moduleUuid, {
		menuSelections: choosingNorth,
		caseDatabase: device,
		identity: SESSION,
	});
	const wire = await evaluateSearchCsqlRuntime(
		{
			doc,
			moduleUuid,
			caseListConfig,
			answers: new Map(Object.entries(answers)),
			session: SESSION,
			sessionData: step.data,
			caseDatabase: device,
			...(lookup === undefined ? {} : { lookup }),
		},
		onDevice,
	);
	if (wire === undefined)
		return {
			query: undefined,
			rejected: false,
			refusal: undefined,
			unevaluated: false,
		};
	// The wire is plain JSON: what crosses is what the server reads.
	const crossed = parseSearchCsqlRuntimeWire(JSON.parse(JSON.stringify(wire)));
	if (crossed === undefined) throw new Error("The wire did not cross.");
	// The server names the tables from its own definitions snapshot.
	const naming =
		lookup === undefined ? undefined : lookupWireNaming(lookup.definitions);
	return {
		query: foldSearchCsql(doc, moduleUuid, caseListConfig, crossed, naming)
			?.query,
		rejected: searchCsqlRejected(crossed),
		refusal: crossed.refusal,
		unevaluated: crossed.unevaluated === true,
	};
}

const holdsNoRuntimeLeaf = (expression: Expression | undefined) => {
	const text = JSON.stringify(expression);
	for (const leaf of [
		'"session-datum"',
		'"input"',
		'"today"',
		'"project"',
		'"when-input-present"',
		'"table-lookup"',
	])
		expect(text).not.toContain(leaf);
};

/** A Members module whose one advanced input holds `predicate`, beside text
 * inputs the predicate reads. */
function withRule(
	predicate: Expression,
	inputNames: readonly string[],
): { doc: BlueprintDoc; moduleUuid: Uuid } {
	const doc = chosenCase.doc();
	const moduleUuid = moduleNamed(doc, "Members by household");
	const mod = doc.modules[moduleUuid];
	if (mod?.caseListConfig === undefined) throw new Error("No case list.");
	mod.caseListConfig.searchInputs = [
		...inputNames.map((name) =>
			simpleSearchInputDef(
				testUuid(`fold-preview-${name}`),
				name,
				name,
				"text",
				"case_name",
			),
		),
		advancedSearchInputDef(
			testUuid("fold-preview-rule"),
			"rule",
			"Rule",
			"text",
			predicate,
		),
	];
	return { doc, moduleUuid };
}
const ref = (name: string) => input(testUuid(`fold-preview-${name}`));

describe("a search's runtime values in Preview", () => {
	it("folds the case chosen in an earlier menu into the search", async () => {
		const doc = chosenCase.doc();
		const { query } = await searched(
			doc,
			moduleNamed(doc, "Members by household"),
		);
		holdsNoRuntimeLeaf(query);
		expect(JSON.stringify(query)).toContain(`"${NORTH}"`);
	});

	it("folds a property of that case from the device's cases", async () => {
		const doc = chosenCase.doc();
		const { query } = await searched(
			doc,
			moduleNamed(doc, "Members by household and village"),
		);
		holdsNoRuntimeLeaf(query);
		expect(JSON.stringify(query)).toContain('"North"');
	});

	it("gives a browse list's filter the case chosen before it", async () => {
		const doc = chosenCase.doc();
		expect(
			caseListStepSession(doc, moduleNamed(doc, "Members by village"), {
				menuSelections: choosingNorth,
				caseDatabase: device,
				identity: SESSION,
			}).chosenCaseIds,
		).toEqual({ [households]: NORTH });
	});

	it("folds a runtime choice to the branch the device took", async () => {
		const { doc, moduleUuid } = withRule(
			ifExpr(
				eq(term(ref("mode")), term(literal("by-name"))),
				eq(prop("member", "case_name"), term(literal("Ada"))),
				eq(prop("member", "home_village"), term(literal("South"))),
			),
			["mode"],
		);
		expect(
			(await searched(doc, moduleUuid, { mode: "by-name" })).query,
		).toEqual(eq(prop("member", "case_name"), term(literal("Ada"))));
		expect((await searched(doc, moduleUuid, { mode: "other" })).query).toEqual(
			eq(prop("member", "home_village"), term(literal("South"))),
		);
	});

	it("folds a runtime distance to a number", async () => {
		const { doc, moduleUuid } = withRule(
			within(
				{ kind: "prop", caseType: "member", property: "home_village" },
				term(literal("0 0")),
				term(ref("radius")),
				"miles",
			),
			["radius"],
		);
		const { query, rejected } = await searched(doc, moduleUuid, {
			radius: "4",
		});
		expect(rejected).toBe(false);
		expect(query).toMatchObject({ kind: "within-distance", distance: 4 });
	});

	it("finds nothing where the device's obligation holds", async () => {
		const { doc, moduleUuid } = withRule(
			within(
				{ kind: "prop", caseType: "member", property: "home_village" },
				term(literal("0 0")),
				term(ref("radius")),
				"miles",
			),
			["radius"],
		);
		// The answer's own prompt carries the message, so the search holds
		// no refusal of its own.
		expect(await searched(doc, moduleUuid, { radius: "far" })).toMatchObject({
			rejected: true,
			refusal: undefined,
		});
	});

	it("names the obligation no prompt carries when the device's cases break it", async () => {
		// The radius is the chosen household's village, which only the
		// device's cases hold: "North" is no distance.
		const { doc, moduleUuid } = withRule(
			within(
				{ kind: "prop", caseType: "member", property: "home_village" },
				term(literal("0 0")),
				chosenCaseProperty(households, "household", "village"),
				"miles",
			),
			[],
		);
		expect(await searched(doc, moduleUuid)).toMatchObject({
			rejected: true,
			refusal: "positive-number",
		});
	});

	it("keeps a blank comparand silent: the search finds nothing", async () => {
		const { doc, moduleUuid } = withRule(
			gte(
				prop("member", "case_name"),
				chosenCaseProperty(households, "household", "missing_note"),
			),
			[],
		);
		expect(await searched(doc, moduleUuid)).toMatchObject({
			rejected: true,
			refusal: undefined,
		});
	});

	it("refuses a refusal the wire never names", async () => {
		expect(() =>
			parseSearchCsqlRuntimeWire({
				segments: {},
				choices: { "0": true },
				refusal: "blank-comparand",
			}),
		).toThrow(SearchCsqlRuntimeError);
	});

	it("folds today() to the viewer's own day", async () => {
		const { doc, moduleUuid } = withRule(
			gte(prop("member", "case_name"), today()),
			[],
		);
		const day = xpathToString(
			evaluate("today()", {
				contextPath: "",
				position: 1,
				getValue: () => undefined,
			}),
		);
		const { query } = await searched(doc, moduleUuid);
		holdsNoRuntimeLeaf(query);
		expect(JSON.stringify(query)).toContain(`"${day}"`);
	});
});

// A list item the device works out is held to the `list-item` obligation as
// the emitter wrote it: guarded by the choice that prints it and by its
// input's presence, and over the item's own value.
describe("a list item's obligation in Preview", () => {
	const listOf = (name: string) =>
		eq(prop("member", "case_name"), {
			kind: "value-list",
			items: [term(ref(name))],
		});
	const quoted = 'say "hi"';

	it("rejects nothing from a branch the device does not take", async () => {
		const { doc, moduleUuid } = withRule(
			ifExpr(
				eq(term(ref("mode")), term(literal("list"))),
				listOf("value"),
				eq(prop("member", "home_village"), term(literal("South"))),
			),
			["mode", "value"],
		);
		expect(
			(await searched(doc, moduleUuid, { mode: "other", value: quoted }))
				.rejected,
		).toBe(false);
		expect(
			(await searched(doc, moduleUuid, { mode: "list", value: quoted }))
				.rejected,
		).toBe(true);
	});

	it("rejects nothing while the input that gates the clause is unanswered", async () => {
		const { doc, moduleUuid } = withRule(
			whenInput(ref("gate"), listOf("value")),
			["gate", "value"],
		);
		expect((await searched(doc, moduleUuid, { value: quoted })).rejected).toBe(
			false,
		);
		expect(
			(await searched(doc, moduleUuid, { gate: "yes", value: quoted }))
				.rejected,
		).toBe(true);
	});

	it("judges one value holding the list's own separator whole", async () => {
		const { doc, moduleUuid } = withRule(listOf("value"), ["value"]);
		expect((await searched(doc, moduleUuid, { value: 'a","b' })).rejected).toBe(
			true,
		);
		expect((await searched(doc, moduleUuid, { value: "a, b" })).rejected).toBe(
			false,
		);
	});
});

describe("a piece only the XPath worker runs", () => {
	// A pattern the author wrote runs only in the XPath worker's Java engine:
	// Preview's synchronous evaluator hands it over, over the same instances.
	const patterned = () =>
		withRule(
			ifExpr(
				matchesPattern(term(ref("mode")), "[a-z]+"),
				eq(prop("member", "case_name"), term(literal("Ada"))),
				eq(prop("member", "home_village"), term(literal("South"))),
			),
			["mode"],
		);
	/** The worker's evaluation, as its runtime evaluates a request. */
	const worker: SearchCsqlDeviceEvaluator = (xpath) =>
		evaluateAsync(xpath.source, {
			contextPath: "",
			position: 1,
			getValue: () => undefined,
			resolveXPathInstance: (id) => xpath.instances.get(id),
			invokeGeneratedFunction: invokeGeneratedJavaRosaFunction,
		});

	it("is worked out in the worker, as the device works it out", async () => {
		const { doc, moduleUuid } = patterned();
		const taken = await searched(
			doc,
			moduleUuid,
			{ mode: "abc" },
			undefined,
			worker,
		);
		expect(taken).toMatchObject({
			unevaluated: false,
			query: eq(prop("member", "case_name"), term(literal("Ada"))),
		});
		expect(
			(await searched(doc, moduleUuid, { mode: "ABC" }, undefined, worker))
				.query,
		).toEqual(eq(prop("member", "home_village"), term(literal("South"))));
	});

	it("sends no further piece to the worker once superseded, and never a cancel", async () => {
		const { doc, moduleUuid } = patterned();
		const caseListConfig = doc.modules[moduleUuid]?.caseListConfig;
		if (caseListConfig === undefined) throw new Error("No case list.");
		const superseded = new AbortController();
		let requests = 0;
		const once: SearchCsqlDeviceEvaluator = (...args) => {
			requests += 1;
			// The worker is asked for the piece alone: no signal to cancel it.
			expect(args).toHaveLength(1);
			superseded.abort();
			return worker(...args);
		};
		await evaluateSearchCsqlRuntime(
			{
				doc,
				moduleUuid,
				caseListConfig,
				answers: new Map([["mode", "abc"]]),
				session: SESSION,
				caseDatabase: device,
			},
			once,
			superseded.signal,
		);
		expect(requests).toBe(1);
	});

	it("asks the worker for each piece, never the whole row again", async () => {
		const { doc, moduleUuid } = patterned();
		const asked: string[] = [];
		const counting: SearchCsqlDeviceEvaluator = (xpath) => {
			asked.push(xpath.source);
			return worker(xpath);
		};
		await searched(doc, moduleUuid, { mode: "abc" }, undefined, counting);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain("regex(");
	});

	it("sends the worker's pieces together, not one after another", async () => {
		// Two rows, each choosing by a pattern: both pieces are in the worker
		// before either answers.
		const { doc, moduleUuid } = withRule(
			ifExpr(
				matchesPattern(term(ref("mode")), "[a-z]+"),
				eq(prop("member", "case_name"), term(literal("Ada"))),
				eq(prop("member", "home_village"), term(literal("South"))),
			),
			["mode"],
		);
		const caseListConfig = doc.modules[moduleUuid]?.caseListConfig;
		if (caseListConfig === undefined) throw new Error("No case list.");
		caseListConfig.filter = ifExpr(
			matchesPattern(term(ref("mode")), "[0-9]+"),
			eq(prop("member", "case_name"), term(literal("Bo"))),
			eq(prop("member", "home_village"), term(literal("North"))),
		);
		const waiting: (() => void)[] = [];
		const held: SearchCsqlDeviceEvaluator = (xpath) =>
			new Promise((resolve, reject) => {
				waiting.push(() => worker(xpath).then(resolve, reject));
				if (waiting.length === 2) for (const answer of waiting) answer();
			});
		const { query, unevaluated } = await searched(
			doc,
			moduleUuid,
			{ mode: "abc" },
			undefined,
			held,
		);
		expect(waiting).toHaveLength(2);
		expect(unevaluated).toBe(false);
		expect(JSON.stringify(query)).toContain('"Ada"');
		expect(JSON.stringify(query)).toContain('"North"');
	});

	it("works out only the branch the device takes", async () => {
		// The pattern sits in the branch taken only for "by-pattern": with no
		// worker, the other branch is still worked out whole.
		const { doc, moduleUuid } = withRule(
			ifExpr(
				eq(term(ref("mode")), term(literal("by-pattern"))),
				ifExpr(
					matchesPattern(term(ref("mode")), "[a-z]+"),
					eq(prop("member", "case_name"), term(literal("Ada"))),
					eq(prop("member", "case_name"), term(literal("Bo"))),
				),
				eq(prop("member", "home_village"), term(literal("South"))),
			),
			["mode"],
		);
		expect(await searched(doc, moduleUuid, { mode: "other" })).toMatchObject({
			unevaluated: false,
			query: eq(prop("member", "home_village"), term(literal("South"))),
		});
		expect(
			(await searched(doc, moduleUuid, { mode: "by-pattern" })).unevaluated,
		).toBe(true);
	});

	it("marks the search Preview can't work out where the worker can't either", async () => {
		const { doc, moduleUuid } = patterned();
		const refusing: SearchCsqlDeviceEvaluator = () =>
			Promise.reject(new Error("The worker can't run this."));
		expect(
			(await searched(doc, moduleUuid, { mode: "abc" }, undefined, refusing))
				.unevaluated,
		).toBe(true);
		expect((await searched(doc, moduleUuid, { mode: "abc" })).unevaluated).toBe(
			true,
		);
	});

	it("keeps the mark across the wire and refuses any other value of it", async () => {
		const wire = { segments: {}, choices: {}, unevaluated: true };
		expect(parseSearchCsqlRuntimeWire(wire)).toEqual(wire);
		expect(() =>
			parseSearchCsqlRuntimeWire({ ...wire, unevaluated: false }),
		).toThrow(SearchCsqlRuntimeError);
	});
});

describe("a lookup value in a search, on both sides", () => {
	it("folds to the literal of its column's type", async () => {
		const tableId = lookupTableIdSchema.parse(
			"018f0000-0000-7000-8000-000000000201",
		);
		const code = lookupColumnIdSchema.parse(
			"018f0000-0000-7000-8000-000000000202",
		);
		const rank = lookupColumnIdSchema.parse(
			"018f0000-0000-7000-8000-000000000203",
		);
		const lookup = previewLookupData({
			projectRevision: "1",
			definitions: [
				{
					id: tableId,
					name: "Ranks",
					tag: "ranks",
					definitionRevision: parseLookupRevision("1"),
					columns: [
						{ id: code, wireName: "code", label: "Code", dataType: "text" },
						{ id: rank, wireName: "rank", label: "Rank", dataType: "int" },
					],
				},
			],
			rowsByTable: new Map([
				[
					tableId,
					[
						{
							id: lookupRowIdSchema.parse(
								"018f0000-0000-7000-8000-000000000211",
							),
							values: { [code]: "a", [rank]: 7 },
						},
					],
				],
			]),
		});
		const { doc, moduleUuid } = withRule(
			eq(
				prop("member", "case_name"),
				tableLookup(
					tableId,
					rank,
					eq(tableColumn(tableId, code), literal("a")),
				),
			),
			[],
		);
		const { query } = await searched(doc, moduleUuid, {}, lookup);
		holdsNoRuntimeLeaf(query);
		expect(query).toEqual(
			eq(
				prop("member", "case_name"),
				term({ kind: "literal", value: 7, data_type: "int" }),
			),
		);
	});
});

describe("the search rows a Results read compiles", () => {
	// The households' villages as the device's cases hold them: a projection
	// only the device can work out.
	const deviceVillages: Expression = {
		kind: "project",
		of: { kind: "cases", source: "casedb", where: [] },
		value: { kind: "prop", caseType: "household", property: "village" },
	};
	const ruleOverDevice = () =>
		withRule(
			eq(prop("member", "home_village"), {
				kind: "value-list",
				items: [deviceVillages],
			}),
			[],
		);
	const read = (
		keyed: boolean,
		wire: SearchCsqlRuntimeWire | undefined,
		{ doc, moduleUuid }: { doc: BlueprintDoc; moduleUuid: Uuid },
	) => {
		const caseListConfig = doc.modules[moduleUuid]?.caseListConfig;
		if (caseListConfig === undefined) throw new Error("No case list.");
		return searchCsqlForRead({ keyed, doc, moduleUuid, caseListConfig, wire });
	};

	it("applies no row to the case the no-matches form registered", async () => {
		const search = ruleOverDevice();
		expect(read(true, undefined, search)).toEqual({
			query: { kind: "match-all" },
			authored: undefined,
			readsAnswers: false,
			unfoldedDeviceRead: false,
		});
	});

	it("marks a device read no value reached, and not one the browser folded", async () => {
		const search = ruleOverDevice();
		expect(read(false, undefined, search)?.unfoldedDeviceRead).toBe(true);
		const caseListConfig =
			search.doc.modules[search.moduleUuid]?.caseListConfig;
		if (caseListConfig === undefined) throw new Error("No case list.");
		const wire = await evaluateSearchCsqlRuntime({
			doc: search.doc,
			moduleUuid: search.moduleUuid,
			caseListConfig,
			answers: new Map(),
			session: SESSION,
			caseDatabase: device,
		});
		expect(read(false, wire, search)?.unfoldedDeviceRead).toBe(false);
	});

	it("leaves a chosen case's property to the store, which reads its row", async () => {
		const search = withRule(
			eq(
				prop("member", "home_village"),
				chosenCaseProperty(households, "household", "village"),
			),
			[],
		);
		expect(read(false, undefined, search)?.unfoldedDeviceRead).toBe(false);
	});
});

describe("a form's display condition after a parent menu's choice", () => {
	it("reads the case chosen in the parent menu from the menu's session", async () => {
		const doc = chosenCase.doc();
		const members = moduleNamed(doc, "Members by village");
		const formUuid = doc.formOrder[members]?.[0];
		if (formUuid === undefined) throw new Error("No member form.");
		const form = doc.forms[formUuid];
		if (form === undefined) throw new Error("No member form.");
		form.displayCondition = eq(
			chosenCaseProperty(households, "household", "village"),
			term(literal("North")),
		);
		const visibility = (village: string) =>
			formDisplayVisibility({
				condition: form.displayCondition,
				session: SESSION,
				types: previewExpressionContext(doc, {
					entity: "form",
					uuid: formUuid,
					slot: "form_display_condition",
				}),
				selectedCase: navigationSelectedCase(
					doc,
					members,
					formUuid,
					"csql-member-north-north",
					caseListStepSession(doc, members, {
						menuSelections: choosingNorth,
						caseDatabase: device,
						identity: SESSION,
					}).data,
				),
				deviceCases: {
					snapshot: {
						rows: [row(NORTH, "household", { village })],
						indices: [],
					},
					caseTypes: doc.caseTypes ?? [],
				},
				lookup: { kind: "idle" },
			});
		expect(visibility("North")).toBe("shown");
		expect(visibility("South")).toBe("hidden");
	});
});
