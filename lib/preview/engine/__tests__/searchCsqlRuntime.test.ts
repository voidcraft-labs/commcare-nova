import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseRow } from "@/lib/case-store";
import { chosenCase } from "@/lib/commcare/__tests__/csqlCompositionFixture";
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
	prop,
	term,
	today,
	within,
} from "@/lib/domain/expression/builders";
import { chosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import type { Expression } from "@/lib/domain/expression/types";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { xpathToString } from "../../xpath/coerce";
import { evaluate } from "../../xpath/evaluator";
import {
	formDisplayVisibility,
	navigationSelectedCase,
} from "../displayConditionEvaluation";
import { caseListStepSession } from "../entrySessionData";
import { previewExpressionContext } from "../expressionContext";
import type { PreviewSearchSessionValues } from "../identity";
import {
	evaluateSearchCsqlRuntime,
	foldSearchCsql,
	parseSearchCsqlRuntimeWire,
	SearchCsqlRuntimeError,
	type SearchCsqlRuntimeWire,
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
function searched(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	answers: Record<string, string> = {},
): {
	readonly query: Expression | undefined;
	readonly rejected: boolean;
	readonly refusal: SearchCsqlRuntimeWire["refusal"];
} {
	const caseListConfig = doc.modules[moduleUuid]?.caseListConfig;
	if (caseListConfig === undefined) throw new Error("No case list.");
	const step = caseListStepSession(doc, moduleUuid, {
		menuSelections: choosingNorth,
		caseDatabase: device,
		identity: SESSION,
	});
	const wire = evaluateSearchCsqlRuntime({
		doc,
		moduleUuid,
		caseListConfig,
		answers: new Map(Object.entries(answers)),
		session: SESSION,
		sessionData: step.data,
		caseDatabase: device,
	});
	if (wire === undefined)
		return { query: undefined, rejected: false, refusal: undefined };
	// The wire is plain JSON: what crosses is what the server reads.
	const crossed = parseSearchCsqlRuntimeWire(JSON.parse(JSON.stringify(wire)));
	if (crossed === undefined) throw new Error("The wire did not cross.");
	return {
		query: foldSearchCsql(doc, moduleUuid, caseListConfig, crossed)?.query,
		rejected: searchCsqlRejected(crossed),
		refusal: crossed.refusal,
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
	it("folds the case chosen in an earlier menu into the search", () => {
		const doc = chosenCase.doc();
		const { query } = searched(doc, moduleNamed(doc, "Members by household"));
		holdsNoRuntimeLeaf(query);
		expect(JSON.stringify(query)).toContain(`"${NORTH}"`);
	});

	it("folds a property of that case from the device's cases", () => {
		const doc = chosenCase.doc();
		const { query } = searched(
			doc,
			moduleNamed(doc, "Members by household and village"),
		);
		holdsNoRuntimeLeaf(query);
		expect(JSON.stringify(query)).toContain('"North"');
	});

	it("gives a browse list's filter the case chosen before it", () => {
		const doc = chosenCase.doc();
		expect(
			caseListStepSession(doc, moduleNamed(doc, "Members by village"), {
				menuSelections: choosingNorth,
				caseDatabase: device,
				identity: SESSION,
			}).chosenCaseIds,
		).toEqual({ [households]: NORTH });
	});

	it("folds a runtime choice to the branch the device took", () => {
		const { doc, moduleUuid } = withRule(
			ifExpr(
				eq(term(ref("mode")), term(literal("by-name"))),
				eq(prop("member", "case_name"), term(literal("Ada"))),
				eq(prop("member", "home_village"), term(literal("South"))),
			),
			["mode"],
		);
		expect(searched(doc, moduleUuid, { mode: "by-name" }).query).toEqual(
			eq(prop("member", "case_name"), term(literal("Ada"))),
		);
		expect(searched(doc, moduleUuid, { mode: "other" }).query).toEqual(
			eq(prop("member", "home_village"), term(literal("South"))),
		);
	});

	it("folds a runtime distance to a number", () => {
		const { doc, moduleUuid } = withRule(
			within(
				{ kind: "prop", caseType: "member", property: "home_village" },
				term(literal("0 0")),
				term(ref("radius")),
				"miles",
			),
			["radius"],
		);
		const { query, rejected } = searched(doc, moduleUuid, { radius: "4" });
		expect(rejected).toBe(false);
		expect(query).toMatchObject({ kind: "within-distance", distance: 4 });
	});

	it("finds nothing where the device's obligation holds", () => {
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
		expect(searched(doc, moduleUuid, { radius: "far" })).toMatchObject({
			rejected: true,
			refusal: undefined,
		});
	});

	it("names the obligation no prompt carries when the device's cases break it", () => {
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
		expect(searched(doc, moduleUuid)).toMatchObject({
			rejected: true,
			refusal: "positive-number",
		});
	});

	it("keeps a blank comparand silent: the search finds nothing", () => {
		const { doc, moduleUuid } = withRule(
			gte(
				prop("member", "case_name"),
				chosenCaseProperty(households, "household", "missing_note"),
			),
			[],
		);
		expect(searched(doc, moduleUuid)).toMatchObject({
			rejected: true,
			refusal: undefined,
		});
	});

	it("refuses a refusal the wire never names", () => {
		expect(() =>
			parseSearchCsqlRuntimeWire({
				segments: {},
				choices: { "0": true },
				refusal: "blank-comparand",
			}),
		).toThrow(SearchCsqlRuntimeError);
	});

	it("folds today() to the viewer's own day", () => {
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
		const { query } = searched(doc, moduleUuid);
		holdsNoRuntimeLeaf(query);
		expect(JSON.stringify(query)).toContain(`"${day}"`);
	});
});

describe("a form's display condition after a parent menu's choice", () => {
	it("reads the case chosen in the parent menu from the menu's session", () => {
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
