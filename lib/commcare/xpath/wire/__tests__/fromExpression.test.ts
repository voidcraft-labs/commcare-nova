import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	clinicNames,
	INSTANCE_READS,
	instanceReadFixture,
} from "@/lib/commcare/__tests__/instanceReadFixture";
import {
	type CaseType,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	anyRelationPath,
	arith,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	datetimeCoerce,
	datetimeLiteral,
	eq,
	exists,
	formatDate,
	gt,
	ifExpr,
	input,
	literal,
	lt,
	match,
	neq,
	now,
	prop,
	relationStep,
	sessionContext,
	sessionUserProperty,
	subcasePath,
	switchCase,
	switchExpr,
	tableColumn,
	tableLookup,
	term,
	today,
} from "@/lib/domain/expression/builders";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import { expressionSchema } from "@/lib/domain/expression/types";
import { w } from "../builders";
import { toWire, type WireBuildContext } from "../fromExpression";
import {
	caseDbInstance,
	searchInputInstance,
	sessionInstance,
} from "../instances";
import { instantMicros } from "../instant";
import { casePropertyStep } from "../rowScope";
import { serializeWire } from "../serialize";
import { instantFixture } from "./instantFixture";

const MODULE = testUuid("wire-module");
function wireContext(
	caseTypes: readonly CaseType[] = [
		{ name: "patient", parent_type: "household", properties: [] },
		{ name: "household", properties: [] },
		{ name: "visit", parent_type: "household", properties: [] },
	],
	searchInputs: readonly SearchInputDef[] = [],
): WireBuildContext {
	const doc = buildDoc({
		caseTypes: [...caseTypes],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([]),
					searchInputs: [...searchInputs],
				},
			},
		],
	});
	const types = slotContext(
		doc,
		{ entity: "module", uuid: MODULE, slot: "case_list_filter" },
		new Map(),
	);
	if (types === undefined)
		throw new Error("The wire fixture has no list-filter context.");
	return { target: "suite", types };
}
const context = wireContext();
const lower = (expression: Expression) => toWire(expression, context);

// These observations belong to lowering: identity resolution, scalar admission,
// scope and operation choice. Grammar spelling and native answers have separate
// serializer tests and the independent Core evidence family.
describe("domain expressions become typed wire trees", () => {
	it("keeps literal bytes out of paths and resolves reserved case metadata", () => {
		expect(
			lower(eq(prop("patient", "case_id"), literal("instance('other')/#case"))),
		).toEqual(
			w.eq(w.context([w.attr("case_id")]), w.str("instance('other')/#case")),
		);
		expect(lower(term(literal(false)))).toEqual(w.str("false"));
		expect(lower(term(literal(null)))).toEqual(w.str(""));
	});

	it("keeps integer division's zero branch and signed remainder lowering", () => {
		expect(
			lower(arith("quotient", term(literal(-7)), term(literal(2)))),
		).toEqual(
			w.call("if", [
				w.eq(w.num(2), w.num(0)),
				w.div(w.num(-7), w.num(2)),
				w.div(w.sub(w.num(-7), w.mod(w.num(-7), w.num(2))), w.num(2)),
			]),
		);
	});

	it("keeps div real even when both literals are integers", () => {
		expect(lower(arith("div", term(literal(-7)), term(literal(2))))).toEqual(
			w.div(w.num(-7), w.num(2)),
		);
	});

	it("preserves literal date patterns and evaluates computed patterns", () => {
		expect(lower(formatDate(today(), "short"))).toEqual(
			w.call("format-date", [w.call("today"), w.str("%m/%d/%Y")]),
		);
		expect(lower(formatDate(today(), term(literal("short"))))).toEqual(
			w.call("format-date", [w.call("today"), w.str("short")]),
		);
		expect(
			lower(
				formatDate(today(), concat(term(literal("%Y")), term(literal("-%m")))),
			),
		).toEqual(
			w.call("format-date", [
				w.call("today"),
				w.call("concat", [w.str("%Y"), w.str("-%m")]),
			]),
		);
	});

	it("keeps query filters and index projection in their own lexical row", () => {
		const expression: Expression = {
			kind: "project",
			of: {
				kind: "cases",
				source: "casedb",
				where: [
					eq(term({ kind: "prop", property: "case_name" }), literal("Sam")),
				],
			},
			value: { kind: "case-index", identifier: "parent" },
		};
		const tree = toWire(expression, {
			...context,
			bindings: {
				caseProperty: () => w.str("outer selected case"),
				emitSelfProperty: () => w.str("outer property"),
			},
		});
		expect(tree).toEqual(
			w.instance(caseDbInstance(), [
				w.step("casedb"),
				w.step("case", [w.eq(w.context([w.step("case_name")]), w.str("Sam"))]),
				w.step("index"),
				w.step("parent"),
			]),
		);
	});

	it("retains explicit generated overrides when their count identity normalizes", () => {
		const originalCount = count(anyRelationPath("parent", "household"));
		const generated = w.form(["held_count"]);
		const tree = toWire(gt(originalCount, literal(0)), {
			...context,
			overrides: new Map([[originalCount, generated]]),
		});
		expect(tree).toEqual(w.gt(generated, w.num(0)));
	});

	it("resolves identity bindings to their exact trees without parsing text", () => {
		const field = testUuid("field"),
			operation = testUuid("operation");
		const fieldTree = w.form(["repeat", "answer"]),
			operationTree = w.form([w.step("case"), w.attr("case_id")]);
		expect(
			toWire(
				{ kind: "term", term: { kind: "field", uuid: field } },
				{ ...context, bindings: { formFields: new Map([[field, fieldTree]]) } },
			),
		).toBe(fieldTree);
		expect(
			toWire(
				{ kind: "id-of", opUuid: operation },
				{
					...context,
					bindings: { operationIds: new Map([[operation, operationTree]]) },
				},
			),
		).toBe(operationTree);
	});

	it("uses current search names and preserves the contextual instance declaration", () => {
		const uuid = testUuid("search");
		const tree = toWire(term(input(uuid)), {
			...wireContext(undefined, [
				simpleSearchInputDef(uuid, "current_name", "Name", "text", "case_name"),
			]),
			bindings: { searchInputInstanceId: "search-input:custom" },
		});
		const answers = searchInputInstance("search-input:custom");
		expect(tree).toEqual(
			w.call("if", [
				w.gt(
					w.call("count", [
						w.instance(answers, [w.step("input"), w.step("field")]),
					]),
					w.num(0),
				),
				w.expansion(
					"search",
					w.instance(answers, [
						w.step("input"),
						w.step("field", [
							w.eq(w.context([w.attr("name")]), w.str("current_name")),
						]),
					]),
				),
				w.str(""),
			]),
		);
		expect([...serializeWire(tree, { target: "suite" }).instances]).toEqual([
			searchInputInstance("search-input:custom"),
		]);
	});

	it("narrows a graph-proven parent relation and holds its destination case type", () => {
		const tree = toWire(
			term(prop("patient", "district", anyRelationPath("parent", "household"))),
			wireContext([
				{ name: "patient", parent_type: "household", properties: [] },
				{ name: "household", properties: [] },
			]),
		);
		expect(tree).toEqual(
			w.instance(caseDbInstance(), [
				w.step("casedb"),
				w.step("case", [
					w.and(
						w.eq(
							w.context([w.attr("case_id")]),
							w.current([w.step("index"), w.step("parent")]),
						),
						w.eq(w.context([w.attr("case_type")]), w.str("household")),
					),
				]),
				w.step("district"),
			]),
		);
	});

	it("counts children from the enclosing singleton ancestor, with no lexical current rebinding", () => {
		const tree = lower(
			ifExpr(
				exists(
					ancestorPath(relationStep("parent", "household")),
					gt(count(subcasePath("parent", "visit")), literal(0)),
				),
				term(literal("yes")),
				term(literal("no")),
			),
		);
		const expectedAnchor = w.instance(caseDbInstance(), [
			w.step("casedb"),
			w.step("case", [
				w.and(
					w.eq(
						w.context([w.attr("case_id")]),
						w.current([w.step("index"), w.step("parent")]),
					),
					w.eq(w.context([w.attr("case_type")]), w.str("household")),
				),
			]),
			w.attr("case_id"),
		]);
		expect(JSON.stringify(tree)).toContain(JSON.stringify(expectedAnchor));
		expect([...serializeWire(tree, { target: "suite" }).instances]).toEqual([
			caseDbInstance(),
		]);
	});

	it("keeps form-selected case bindings independent from candidate-row terms", () => {
		const selected = w.instance(sessionInstance(), [
			w.step("session"),
			w.step("data"),
			w.step("case_id"),
		]);
		const result = toWire(eq(prop("patient", "name"), literal("Sam")), {
			...context,
			bindings: {
				caseProperty: (property, _root, scope) =>
					scope === "root"
						? w.instance(caseDbInstance(), [
								w.step("casedb"),
								w.step("case", [
									w.eq(w.context([w.attr("case_id")]), selected),
								]),
								casePropertyStep(property.property),
							])
						: undefined,
			},
		});
		expect([...serializeWire(result, { target: "suite" }).instances]).toEqual([
			caseDbInstance(),
			sessionInstance(),
		]);
	});

	it("resolves inherited worker bindings and retains only their session dependency", () => {
		const uuid = testUuid("worker-property");
		const tree = toWire(term(sessionUserProperty(uuid)), {
			...context,
			bindings: { userPropertySlugs: new Map([[uuid, "region"]]) },
		});
		expect(tree).toEqual(
			w.instance(sessionInstance(), [
				w.step("session"),
				w.step("user"),
				w.step("data"),
				w.step("region"),
			]),
		);
		expect(lower(term(sessionContext("userid")))).toEqual(
			w.instance(sessionInstance(), [
				w.step("session"),
				w.step("context"),
				w.step("userid"),
			]),
		);
	});

	it("keeps date coercion and fractional day flooring as explicit operations", () => {
		expect(
			lower(
				dateAdd(
					dateCoerce(term(literal("1969-12-31"))),
					"hours",
					term(literal(-12)),
				),
			),
		).toEqual(
			w.call("date", [
				w.call("floor", [
					w.add(
						w.call("date", [w.str("1969-12-31")]),
						w.div(w.num(-12), w.num(24)),
					),
				]),
			]),
		);
	});
});

describe("wire lowering preserves the prior defensive refusals", () => {
	it.each(["months", "years"] as const)(
		"refuses calendar-relative %s arithmetic",
		(interval) => {
			expect(() => lower(dateAdd(today(), interval, term(literal(1))))).toThrow(
				/calendar-relative date-add interval/i,
			);
		},
	);
	it.each([
		["now", now()],
		["datetime-coerce", datetimeCoerce(term(literal("2020-01-01T12:00:00")))],
		["typed datetime literal", term(datetimeLiteral("2020-01-01T12:00:00"))],
		["nested date-add", dateAdd(now(), "days", term(literal(1)))],
		["null-neutral coalesce", coalesce(now(), term(literal(null)))],
		[
			"null-neutral conditional",
			ifExpr(eq(literal(1), literal(1)), now(), term(literal(null))),
		],
		[
			"null-neutral switch",
			switchExpr(
				term(literal("x")),
				[switchCase(literal("x"), now())],
				term(literal(null)),
			),
		],
	] as const)(
		"refuses a %s datetime base before losing its time",
		(_label, base) => {
			expect(() => lower(dateAdd(base, "days", term(literal(1))))).toThrow(
				/structurally datetime-typed base.*discard the time-of-day/s,
			);
		},
	);

	it("refuses a child count below a multi-case candidate scope", () => {
		const expression = ifExpr(
			exists(
				subcasePath("parent", "visit"),
				gt(count(subcasePath("parent", "followup")), literal(0)),
			),
			term(literal("yes")),
			term(literal("no")),
		);
		expect(() =>
			toWire(
				expression,
				wireContext([
					{ name: "patient", properties: [] },
					{ name: "visit", parent_type: "patient", properties: [] },
					{ name: "followup", parent_type: "visit", properties: [] },
				]),
			),
		).toThrow(
			/child-case count is nested under a relation scope that CommCare Core cannot name/i,
		);
	});
	it("refuses a worker identity without a current saved-name binding", () => {
		expect(() => lower(term(sessionUserProperty(testUuid("missing"))))).toThrow(
			/worker-information property.*has no current saved-name binding/i,
		);
	});
	it.each(["fuzzy", "phonetic", "fuzzy-date"] as const)(
		"refuses server-only match mode %s",
		(mode) => {
			expect(() =>
				lower(match(prop("patient", "full_name"), "alice", mode)),
			).toThrow(/does not register/);
		},
	);
	it("refuses an unbounded between that bypassed the schema", () => {
		const bypassed = {
			kind: "between" as const,
			left: term(prop("patient", "age")),
			lowerInclusive: true,
			upperInclusive: true,
		};
		expect(expressionSchema.safeParse(bypassed).success).toBe(false);
		expect(() => lower(bypassed)).toThrow(/range without a bound/);
	});
});

describe("a comparison no device can answer between moments never reaches the wire", () => {
	const fx = instantFixture({
		dt: "typed",
		stamp: "clock-lost",
		d: "date",
		u: "unknown",
		u2: "unknown",
	});
	const opened = term(prop("visit", "date_opened"));
	it("refuses a casedb system date against a moment", () => {
		expect(() => fx.lowerRecord(gt(opened, now()))).toThrow(
			/only the day of 'date_opened'.*day-only-on-device/s,
		);
		expect(() =>
			fx.lowerRecord(eq(opened, datetimeCoerce(term(literal("2026-01-01"))))),
		).toThrow(/day-only-on-device/);
		expect(() =>
			fx.lowerForm(
				gt(
					term({
						kind: "form-case",
						caseType: "visit",
						property: "last_modified",
					}),
					fx.field("dt"),
				),
			),
		).toThrow(/only the day of 'last_modified'/);
	});
	it("refuses a date and time whose clock may be lost", () => {
		expect(() => fx.lowerForm(gt(fx.field("stamp"), now()))).toThrow(
			/clock may be lost.*clock-lost/s,
		);
	});
	it("refuses a date-and-time literal that names no moment", () => {
		expect(() =>
			fx.lowerRecord(
				lt(
					term(prop("visit", "seen")),
					datetimeLiteral("2026-13-45T10:00:00Z"),
				),
			),
		).toThrow(/'2026-13-45T10:00:00Z' names no moment/);
	});
	it("refuses a date branch compared as a moment", () => {
		expect(() =>
			fx.lowerForm(
				gt(ifExpr(eq(literal(1), literal(1)), today(), now()), fx.field("dt")),
			),
		).toThrow(/date-datetime/);
		expect(() =>
			fx.lowerForm(lt(fx.field("dt"), literal("2026-01-02"))),
		).toThrow(/date-datetime/);
	});
	it("keeps every comparison without a moment as written", () => {
		const name = term(prop("visit", "note"));
		expect(fx.lowerRecord(eq(name, literal("x")))).toEqual(
			w.eq(fx.lowerRecord(name), w.str("x")),
		);
		expect(fx.lowerForm(gt(fx.field("d"), today()))).toEqual(
			w.gt(fx.lowerForm(fx.field("d")), w.call("today")),
		);
		expect(
			fx.lowerForm(
				eq(dateCoerce(fx.field("dt")), dateCoerce(fx.field("stamp"))),
			),
		).toEqual(
			w.eq(
				w.call("date", [fx.lowerForm(fx.field("dt"))]),
				w.call("date", [fx.lowerForm(fx.field("stamp"))]),
			),
		);
		expect(fx.lowerForm(neq(fx.field("stamp"), literal("")))).toEqual(
			w.ne(fx.lowerForm(fx.field("stamp")), w.str("")),
		);
		expect(fx.lowerForm(eq(fx.field("u"), fx.field("u2")))).toEqual(
			w.eq(fx.lowerForm(fx.field("u")), fx.lowerForm(fx.field("u2"))),
		);
	});
	it("compares a value of unknown type with a moment as a moment, under = as under <", () => {
		for (const comparison of [eq, neq, lt] as const) {
			const wire = fx.lowerForm(comparison(fx.field("u"), now()));
			if (wire.k !== "cmp") throw new Error("Expected a comparison.");
			expect(wire.left).toEqual(instantMicros(fx.lowerForm(fx.field("u"))));
		}
	});
});

// Each instance arm chooses its declaration where it builds its root; the
// serializer returns exactly the declarations its printed tree reaches.
describe("instance arms declare what they read, per target", () => {
	const { doc, table, naming } = instanceReadFixture();
	const [value, label] = table.columns;
	const visit = Object.values(doc.fields).find(
		(field) => field.id === "region_label",
	);
	if (visit === undefined) throw new Error("The fixture has no Visit field.");
	const types = slotContext(
		doc,
		{ entity: "field", uuid: visit.uuid, slot: "calculate" },
		new Map([
			[
				table.id,
				new Map(table.columns.map((column) => [column.id, column.dataType])),
			],
		]),
	);
	if (types === undefined) throw new Error("The Visit field has no context.");
	const printed = (
		expression: Expression,
		target: "xform" | "suite",
		bindings: WireBuildContext["bindings"] = {},
	) => {
		const serialized = serializeWire(
			toWire(expression, {
				target,
				types,
				bindings: { ...bindings, lookup: { naming, instanceScope: target } },
			}),
			{ target, constraint: false },
		);
		return {
			text: serialized.text,
			instances: [...serialized.instances].map(({ id, src }) => [id, src]),
		};
	};

	it("names a data table by its tag in a form and by its fixture id in a suite", () => {
		const read = tableLookup(
			table.id,
			label.id,
			eq(tableColumn(table.id, value.id), literal("north")),
		);
		expect(printed(read, "xform")).toEqual({
			text: "if(count(instance('regions')/regions_list/regions) > 0, instance('regions')/regions_list/regions[value = 'north'][1]/label, '')",
			instances: [["regions", "jr://fixture/item-list:regions"]],
		});
		expect(printed(read, "suite")).toEqual({
			text: "if(count(instance('item-list:regions')/regions_list/regions) > 0, instance('item-list:regions')/regions_list/regions[value = 'north'][1]/label, '')",
			instances: [["item-list:regions", "jr://fixture/item-list:regions"]],
		});
	});

	it("declares places for a row read and nothing for a level's code", () => {
		expect(printed(clinicNames(), "suite")).toEqual({
			text: "if(count(instance('locations')/locations/location) > 0, instance('locations')/locations/location[@type = 'clinic']/name, '')",
			instances: [["locations", "jr://fixture/locations"]],
		});
		const clinic = doc.organizationLevelOrder?.[2];
		if (clinic === undefined)
			throw new Error("The fixture has no clinic level.");
		expect(
			printed(term({ kind: "location-level", levelUuid: clinic }), "xform"),
		).toEqual({ text: "'clinic'", instances: [] });
	});

	// Core refuses a value read of a path whose step reaches no node, and a
	// fixture, the chosen cases and the search answers build that path from
	// their rows alone, so each value read is guarded by its rows' count.
	// `count` reads such a path as 0 and keeps it bare.
	describe("a read of rows that may be empty", () => {
		const places =
			"instance('locations')/locations/location[@type = 'clinic']/name";
		const guarded = (read: string, empty = "''") =>
			`if(count(instance('locations')/locations/location) > 0, ${read}, ${empty})`;
		const call = (
			fn: Extract<Expression, { kind: "call" }>["fn"],
			...args: Expression[]
		): Expression => ({ kind: "call", fn, args });

		it("keeps count's node-set bare", () => {
			expect(printed(count(clinicNames()), "suite").text).toBe(
				`count(${places})`,
			);
		});

		it("guards a value, and a node-set join or concat reads as an empty string", () => {
			expect(printed(eq(clinicNames(), literal("x")), "suite").text).toBe(
				`${guarded(places)} = 'x'`,
			);
			expect(
				printed(call("join", term(literal(" ")), clinicNames()), "suite").text,
			).toBe(`join(' ', ${guarded(places)})`);
			expect(printed(concat(clinicNames()), "suite").text).toBe(
				`concat(${guarded(places)})`,
			);
		});

		it("guards a sum at the call, which reads 0 with no rows", () => {
			expect(printed(call("sum", clinicNames()), "suite").text).toBe(
				guarded(`sum(${places})`, "0"),
			);
		});

		it("guards the node-set of distinct-values, index-of and weighted-checklist, which split '' into no values", () => {
			expect(
				printed(
					call(
						"join",
						term(literal(" ")),
						call("distinct-values", clinicNames()),
					),
					"suite",
				).text,
			).toBe(`join(' ', distinct-values(${guarded(places)}))`);
			expect(
				printed(call("index-of", clinicNames(), term(literal("A"))), "suite")
					.text,
			).toBe(`index-of(${guarded(places)}, 'A')`);
			expect(
				printed(
					call(
						"weighted-checklist",
						term(literal(0)),
						term(literal(0)),
						clinicNames(),
						clinicNames(),
					),
					"suite",
				).text,
			).toBe(
				`weighted-checklist(0, 0, ${guarded(places)}, ${guarded(places)})`,
			);
		});

		// `if` hands the branch it takes to sum unconverted, so sum moves into
		// each branch and each branch counts only the rows it reads: a branch
		// over rows that exist answers as written while the other has none.
		describe("a sum over a passed-through node-set", () => {
			const labels: Expression = {
				kind: "project",
				of: { kind: "table-rows", tableId: table.id, where: [] },
				value: tableColumn(table.id, label.id),
			};
			const tableLabels =
				"instance('item-list:regions')/regions_list/regions/label";
			const tableGuarded = (read: string) =>
				`if(count(instance('item-list:regions')/regions_list/regions) > 0, ${read}, 0)`;

			it("guards each branch of an if with the rows that branch reads", () => {
				expect(
					printed(
						call(
							"sum",
							ifExpr(eq(literal(1), literal(1)), clinicNames(), labels),
						),
						"suite",
					).text,
				).toBe(
					`if(1 = 1, ${guarded(`sum(${places})`, "0")}, ${tableGuarded(`sum(${tableLabels})`)})`,
				);
			});

			it("guards a switch's cases and the last value of a coalesce", () => {
				expect(
					printed(
						call(
							"sum",
							switchExpr(
								term(literal("a")),
								[switchCase(literal("a"), labels)],
								clinicNames(),
							),
						),
						"suite",
					).text,
				).toBe(
					`if('a' = 'a', ${tableGuarded(`sum(${tableLabels})`)}, ${guarded(`sum(${places})`, "0")})`,
				);
				expect(
					printed(
						call("sum", coalesce(term(literal("")), clinicNames())),
						"suite",
					).text,
				).toBe(guarded(`sum(coalesce('', ${places}))`, "0"));
			});
		});
		it("keeps a branch bare when count reads what the branch passes through", () => {
			const branch = ifExpr(
				eq(literal(1), literal(1)),
				clinicNames(),
				clinicNames(),
			);
			expect(printed(count(branch), "suite").text).toBe(
				`count(if(1 = 1, ${places}, ${places}))`,
			);
			expect(printed(eq(branch, literal("x")), "suite").text).toBe(
				`if(1 = 1, ${guarded(places)}, ${guarded(places)}) = 'x'`,
			);
		});
	});

	it("reads the chosen cases under the datum id the entry gives them", () => {
		expect(
			printed(
				count({
					kind: "selected-cases",
					module: INSTANCE_READS.batchModule,
				}),
				"xform",
				{ datumId: () => "selected_cases" },
			),
		).toEqual({
			text: "count(instance('selected_cases')/results/value)",
			instances: [
				["selected_cases", "jr://instance/selected-entities/selected_cases"],
			],
		});
	});

	it("prints the related-case exclusion before every condition on what the search found", () => {
		expect(
			printed(
				count({
					kind: "cases",
					source: "search-results",
					where: [eq(prop("patient", "district"), literal("north"))],
				}),
				"suite",
			),
		).toEqual({
			text: "count(instance('results:inline')/results/case[not(commcare_is_related_case = true())][district = 'north'])",
			instances: [["results:inline", "jr://instance/remote/results:inline"]],
		});
	});
});
