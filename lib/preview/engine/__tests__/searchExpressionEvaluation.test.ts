import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import type { CaseRow } from "@/lib/case-store";
import type { SearchInputDef } from "@/lib/domain";
import { simpleSearchInputDef } from "@/lib/domain";
import {
	arith,
	concat,
	count,
	dateAdd,
	double,
	eq,
	gt,
	input,
	isBlank,
	literal,
	prop,
	sessionContext,
	sessionUser,
	term,
	today,
} from "@/lib/domain/expression";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { XPathInvalidPathError } from "@/lib/preview/xpath/runtimeValues";
import type { PreviewSearchSessionValues } from "../identity";
import { previewAsMe, previewSessionValues } from "../identity";
import type { SearchInputValues } from "../runtimeBindings";
import {
	emitPreviewSearchPredicate,
	evaluatePreviewSearchExpression as evaluateExpression,
	evaluatePreviewSearchPredicate as evaluatePredicate,
	parseExcludedOwnerIds,
	resolveSearchInputDefaults as resolveDefaults,
	sessionInstancePathValue,
} from "../searchExpressionEvaluation";
import { caseDatabaseRequirements } from "../useCaseDatabaseSnapshot";

function searchEnvironment(
	inputs: readonly SearchInputDef[],
	expression?: Expression,
	condition?: Expression,
) {
	const moduleUuid = testUuid("search-runtime-module");
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: moduleUuid,
				name: "Patients",
				caseType: "patient",
				caseListConfig: { ...caseListConfig([]), searchInputs: [...inputs] },
				caseSearchConfig: {
					...(expression === undefined ? {} : { excludedOwnerIds: expression }),
					...(condition === undefined
						? {}
						: { searchButtonDisplayCondition: condition }),
				},
			},
		],
	});
	return { doc, moduleUuid };
}
function evaluatePreviewSearchExpression(
	expression: Expression,
	session: PreviewSearchSessionValues,
	values: SearchInputValues = new Map(),
	inputs: readonly SearchInputDef[] = [],
) {
	const environment = searchEnvironment(inputs, expression);
	const types = slotContext(
		environment.doc,
		{
			entity: "module",
			uuid: environment.moduleUuid,
			slot: "excluded_owner_ids",
		},
		new Map(),
	);
	if (types === undefined)
		throw new Error("The search fixture has no scalar context.");
	return evaluateExpression(expression, types, session, values, inputs);
}
function evaluatePreviewSearchPredicate(
	expression: Expression,
	inputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
	values: SearchInputValues = new Map(),
) {
	const environment = searchEnvironment(inputs, undefined, expression);
	// A prompt's own condition reads its siblings' answers; the Search
	// button's reads the session alone.
	const prompt = inputs[0];
	const types = slotContext(
		environment.doc,
		prompt === undefined
			? {
					entity: "module",
					uuid: environment.moduleUuid,
					slot: "search_button_display_condition",
				}
			: {
					entity: "module",
					uuid: environment.moduleUuid,
					slot: "search_input_required_when",
					member: { searchInputUuid: prompt.uuid },
				},
		new Map(),
	);
	if (types === undefined)
		throw new Error("The search fixture has no predicate context.");
	return evaluatePredicate(
		expression,
		types,
		environment,
		inputs,
		session,
		values,
	);
}
it("evaluates a Search button against the device cases before the worker types", () => {
	const type = eq(
		{ kind: "case-row-type" },
		{ kind: "case-type", caseType: "patient" },
	);
	const condition = gt(
		count({ kind: "cases", source: "casedb", where: [type] }),
		literal(1),
	);
	const environment = searchEnvironment([], undefined, condition);
	expect(caseDatabaseRequirements(environment.doc).required).toBe(true);
	const ctx = slotContext(
		environment.doc,
		{
			entity: "module",
			uuid: environment.moduleUuid,
			slot: "search_button_display_condition",
		},
		new Map(),
	);
	if (ctx === undefined)
		throw new Error("The Search button has no evaluation context.");
	const row = (case_id: string, case_type: string): CaseRow =>
		({
			app_id: "search-count",
			case_id,
			case_type,
			status: "open",
			owner_id: "worker-42",
			case_name: case_id,
			external_id: null,
			opened_on: null,
			closed_on: null,
			modified_on: null,
			parent_case_id: null,
			properties: {},
		}) as CaseRow;
	const otherType = row("different", "visit");
	const patient = row("first", "patient");
	const actionVisible = (rows: CaseRow[]) =>
		evaluatePredicate(
			condition,
			ctx,
			{ ...environment, caseDatabase: { rows, indices: [] } },
			[],
			SESSION,
			new Map(),
		);
	expect(actionVisible([patient, otherType])).toBe(false);
	expect(actionVisible([patient, otherType, row("second", "patient")])).toBe(
		true,
	);
});

function resolveSearchInputDefaults(
	inputs: readonly SearchInputDef[],
	session: PreviewSearchSessionValues,
) {
	return resolveDefaults(inputs, session, searchEnvironment(inputs));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-05-06T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const SESSION = previewSessionValues(
	previewAsMe({
		id: "worker-42",
		name: "Amina Diallo",
		email: "amina@example.org",
	}),
	webAppsDevice(),
);

describe("preview case-search expression evaluation", () => {
	it("evaluates explicit quotient separately from real division of a numeric prompt", () => {
		for (const value of [10, -10]) {
			expect(
				evaluatePreviewSearchExpression(
					arith("quotient", term(literal(value)), term(literal(3))),
					SESSION,
				),
			).toBe(String(value > 0 ? 3 : -3));
			const inputDef = simpleSearchInputDef(
				testUuid("numeric-prompt"),
				"amount",
				"Amount",
				"text",
				"amount",
			);
			const expression = arith(
				"div",
				double(term(input(inputDef.uuid))),
				term(literal(3)),
			);
			expect(
				evaluatePreviewSearchExpression(
					expression,
					SESSION,
					new Map([["amount", String(value)]]),
					[inputDef],
				),
			).toBe(String(value / 3));
		}
	});
	it("evaluates literals, date functions, and session-backed terms", () => {
		expect(
			evaluatePreviewSearchExpression(term(literal("north")), SESSION),
		).toBe("north");
		expect(evaluatePreviewSearchExpression(today(), SESSION)).toBe(
			"2026-05-06",
		);
		expect(
			evaluatePreviewSearchExpression(term(sessionContext("userid")), SESSION),
		).toBe("worker-42");
		// `session/user/data` carries CommCare's `commcare_`-prefixed framework
		// keys, not the usercase's unprefixed ones — the two projections are
		// separate, and a device holds no node for an unprefixed name, so Core
		// refuses its read (`XPathNodeset.unpack`) rather than reading a blank.
		expect(
			evaluatePreviewSearchExpression(
				term(sessionUser("commcare_first_name")),
				SESSION,
			),
		).toBe("Amina");
		expect(() =>
			evaluatePreviewSearchExpression(term(sessionUser("first_name")), SESSION),
		).toThrow(XPathInvalidPathError);
	});

	it("binds submitted search inputs before evaluating a dependent expression", () => {
		const clinicInput = simpleSearchInputDef(
			testUuid("clinic"),
			"clinic",
			"Clinic",
			"text",
			"clinic",
		);
		const values: SearchInputValues = new Map([["clinic", "Kolda"]]);
		expect(
			evaluatePreviewSearchExpression(
				concat(term(literal("owner-")), term(input(clinicInput.uuid))),
				SESSION,
				values,
				[clinicInput],
			),
		).toBe("owner-Kolda");
	});

	it("does not resolve session user data through an inherited prototype key", () => {
		const user = Object.create({ constructor: "poison" }) as Record<
			string,
			string
		>;
		expect(
			sessionInstancePathValue("/session/user/data/constructor", {
				context: {},
				user,
				userPropertySlugs: {},
			}),
		).toBeUndefined();
	});

	it("keeps a date widget typed while evaluating dependent date arithmetic", () => {
		const visitDay = simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-000000000104"),
			"visit_day",
			"Visit day",
			"date",
			"visit_day",
		);
		expect(
			evaluatePreviewSearchExpression(
				dateAdd(term(input(visitDay.uuid)), "days", term(literal(1))),
				SESSION,
				new Map([["visit_day", "2026-07-17"]]),
				[visitDay],
			),
		).toBe("2026-07-18");
	});

	it("evaluates search predicates against live inputs, session values, and an empty preselection case context", () => {
		const clinicInput = simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-000000000103"),
			"clinic",
			"Clinic",
			"text",
			"clinic",
		);
		const values: SearchInputValues = new Map([["clinic", "Kolda"]]);

		expect(
			evaluatePreviewSearchPredicate(
				eq(input(clinicInput.uuid), literal("Kolda")),
				[clinicInput],
				SESSION,
				values,
			),
		).toBe(true);
		expect(
			evaluatePreviewSearchPredicate(
				eq(sessionContext("userid"), literal("worker-42")),
				[clinicInput],
				SESSION,
				values,
			),
		).toBe(true);
		expect(
			evaluatePreviewSearchPredicate(
				eq(prop("patient", "case_name"), literal("Alice")),
				[clinicInput],
				SESSION,
				values,
			),
		).toBe(false);
	});

	it("reads the draft through the search-input instance, never from the text", () => {
		const clinicInput = simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-000000000105"),
			"clinic",
			"Clinic",
			"text",
			"clinic",
		);
		const environment = searchEnvironment([clinicInput]);
		const types = slotContext(
			environment.doc,
			{
				entity: "module",
				uuid: environment.moduleUuid,
				slot: "search_input_required_when",
				member: { searchInputUuid: clinicInput.uuid },
			},
			new Map(),
		);
		if (types === undefined)
			throw new Error("The search fixture has no prompt context.");
		const xpath = emitPreviewSearchPredicate(
			eq(input(clinicInput.uuid), literal("Kolda")),
			types,
			environment,
			[clinicInput],
			SESSION,
			new Map([["clinic", "Kolda"]]),
		);
		expect(xpath.source).toBe(
			"if(count(instance('search-input:results')/input/field) > 0, instance('search-input:results')/input/field[@name = 'clinic'], '') = 'Kolda'",
		);
		expect(
			xpath.instances
				.get("search-input:results")
				?.root()
				.children("input")[0]
				?.children("field")
				.map((field) => field.value()),
		).toEqual(["Kolda"]);
		// Core also serves the answers under the legacy id.
		expect(xpath.instances.has("search-input")).toBe(true);
	});

	it("reads an unanswered prompt as blank, the absent node Core leaves for it", () => {
		const clinicInput = simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-000000000106"),
			"clinic",
			"Clinic",
			"text",
			"clinic",
		);
		expect(
			evaluatePreviewSearchPredicate(
				isBlank(input(clinicInput.uuid)),
				[clinicInput],
				SESSION,
			),
		).toBe(true);
		expect(
			evaluatePreviewSearchExpression(
				concat(term(literal("owner-")), term(input(clinicInput.uuid))),
				SESSION,
				new Map(),
				[clinicInput],
			),
		).toBe("owner-");
	});

	it("reads scalar and paired defaults together in the worker session", () => {
		const defaults = resolveSearchInputDefaults(
			[
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000000101"),
					"worker",
					"Worker",
					"text",
					"owner_id",
					{ default: term(sessionContext("userid")) },
				),
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-000000000102"),
					"visit_date",
					"Visit date",
					"date-range",
					"visit_date",
					{
						default: concat(
							term(literal("__range__2024-03-10__")),
							term(literal("2024-03-11")),
						),
					},
				),
			],
			SESSION,
		);

		expect(Object.fromEntries(defaults)).toEqual({
			worker: "worker-42",
			"visit_date:from": "2024-03-10",
			"visit_date:to": "2024-03-11",
		});
	});

	it("splits excluded owners on whitespace, deduplicating without splitting commas", () => {
		expect(
			parseExcludedOwnerIds(" \towner-a  owner-b\nowner-a id3,id4\t "),
		).toEqual(["owner-a", "owner-b", "id3,id4"]);
		expect(parseExcludedOwnerIds(" \t\n ")).toEqual([]);
	});
});
