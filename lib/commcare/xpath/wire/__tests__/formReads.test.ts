import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { slotContext } from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type {
	Expression,
	FieldExpressionSlotRef,
	SlotContextRef,
} from "@/lib/domain/expression/types";
import { formNodeProjection } from "../../formNodeProjection";
import { w } from "../builders";
import { formReads } from "../formReads";
import { toWire } from "../fromExpression";
import { serializeWire } from "../serialize";

const FORM = testUuid("wire-form");
const OUTER = testUuid("wire-outer");
const INNER = testUuid("wire-inner");
const SOURCE = testUuid("wire-source");
const RESULT = testUuid("wire-result");
const CHECKS = testUuid("wire-checks");
const number = (value: number): Expression => ({
	kind: "term",
	term: { kind: "literal", value },
});
const truth: Expression = { kind: "match-all" };

function fixture() {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "survey",
						fields: [
							{
								kind: "repeat",
								id: "outer",
								uuid: OUTER,
								repeat_mode: "query_bound",
								relevant: truth,
								data_source: {
									ids_query: {
										kind: "term",
										term: { kind: "literal", value: "a b" },
									},
								},
								children: [
									{ kind: "int", id: "source", uuid: SOURCE },
									{
										kind: "repeat",
										id: "inner",
										uuid: INNER,
										repeat_mode: "query_bound",
										data_source: {
											ids_query: {
												kind: "term",
												term: { kind: "literal", value: "c" },
											},
										},
										children: [
											{
												kind: "hidden",
												id: "result",
												uuid: RESULT,
												calculate: number(0),
											},
										],
									},
									{
										kind: "repeat",
										id: "checks",
										uuid: CHECKS,
										repeat_mode: "count_bound",
										repeat_count: number(2),
									},
								],
							},
						],
					},
				],
			},
		],
	});
	const form = formStructure(doc, FORM);
	if (form === undefined) throw new Error("The form fixture is incomplete.");
	const projection = formNodeProjection(doc, form);
	return {
		doc,
		projection,
		lower(
			expression: Expression,
			slot: FieldExpressionSlotRef = {
				entity: "field",
				uuid: RESULT,
				slot: "calculate",
			},
		) {
			const types = slotContext(doc, slot, new Map());
			if (types === undefined)
				throw new Error("The form fixture slot is missing.");
			return toWire(expression, { target: "xform", types, form: projection });
		},
	};
}

describe("form reads use native identity coordinates", () => {
	it("counts query wrappers and row nodes as separate physical ancestors", () => {
		const { lower } = fixture();
		expect(
			lower({
				kind: "term",
				term: { kind: "field", uuid: SOURCE, spelling: "current" },
			}),
		).toEqual(
			w.current([w.parent(), w.parent(), w.parent(), w.step("source")]),
		);
		expect(
			lower({
				kind: "term",
				term: {
					kind: "repeat-row",
					repeat: OUTER,
					attribute: "id",
					spelling: "current",
				},
			}),
		).toEqual(w.current([w.parent(), w.parent(), w.parent(), w.attr("id")]));
	});

	it("keeps ids initialization and count calculation at their actual carrier nodes", () => {
		const { lower } = fixture();
		const read: Expression = {
			kind: "term",
			term: {
				kind: "repeat-row",
				repeat: OUTER,
				attribute: "id",
				spelling: "current",
			},
		};
		expect(
			lower(read, { entity: "field", uuid: INNER, slot: "ids_query" }),
		).toEqual(w.current([w.parent(), w.parent(), w.attr("id")]));
		expect(
			lower(read, { entity: "field", uuid: CHECKS, slot: "repeat_count" }),
		).toEqual(w.current([w.parent(), w.attr("id")]));
	});

	it("distinguishes the query wrapper from its item rows", () => {
		const { lower } = fixture();
		const slot = { entity: "field", uuid: OUTER, slot: "relevant" } as const;
		expect(
			lower(
				{
					kind: "term",
					term: {
						kind: "field",
						uuid: OUTER,
						role: "query-wrapper",
						spelling: "relative",
					},
				},
				slot,
			),
		).toEqual(w.context([w.self()]));
		expect(
			lower(
				{
					kind: "term",
					term: { kind: "field", uuid: OUTER, spelling: "relative" },
				},
				slot,
			),
		).toEqual(w.context([w.step("item")]));
	});

	it("re-enters every filtered ancestor instead of skipping a shared prefix", () => {
		const { lower } = fixture();
		const read: Expression = {
			kind: "term",
			term: {
				kind: "field",
				uuid: RESULT,
				spelling: "relative",
				filters: [
					{ step: { kind: "field", uuid: OUTER }, where: [truth] },
					{ step: { kind: "field", uuid: INNER }, where: [truth] },
				],
			},
		};
		expect(lower(read)).toEqual(
			w.context([
				w.parent(),
				w.parent(),
				w.parent(),
				w.parent(),
				w.step("item", [w.call("true")]),
				w.step("inner"),
				w.step("item", [w.call("true")]),
				w.step("result"),
			]),
		);
	});

	it("keeps current fixed at the source while a filter changes relative context", () => {
		const { lower } = fixture();
		const read: Expression = {
			kind: "term",
			term: {
				kind: "field",
				uuid: SOURCE,
				filters: [
					{
						step: { kind: "field", uuid: OUTER },
						where: [
							{
								kind: "eq",
								left: {
									kind: "term",
									term: {
										kind: "repeat-row",
										repeat: OUTER,
										attribute: "id",
										spelling: "relative",
									},
								},
								right: {
									kind: "term",
									term: {
										kind: "repeat-row",
										repeat: OUTER,
										attribute: "id",
										spelling: "current",
									},
								},
							},
						],
					},
				],
			},
		};
		expect(lower(read)).toEqual(
			w.form(
				[
					w.step("outer"),
					w.step("item", [
						w.eq(
							w.context([w.attr("id")]),
							w.current([w.parent(), w.parent(), w.parent(), w.attr("id")]),
						),
					]),
					w.step("source"),
				],
				"hashtag",
			),
		);
	});

	it("defaults anchor even an absolute answer read on the initializing row", () => {
		const { lower } = fixture();
		expect(
			lower(
				{
					kind: "term",
					term: { kind: "field", uuid: SOURCE, spelling: "absolute" },
				},
				{ entity: "field", uuid: SOURCE, slot: "default_value" },
			),
		).toEqual(w.current([w.self()]));
	});

	it("collects exact value and cardinality reads without navigation prefixes", () => {
		const expression: Expression = {
			kind: "count",
			via: {
				kind: "term",
				term: {
					kind: "field",
					uuid: INNER,
					filters: [
						{
							step: { kind: "field", uuid: OUTER },
							where: [
								{
									kind: "gt",
									left: { kind: "term", term: { kind: "field", uuid: SOURCE } },
									right: number(0),
								},
							],
						},
					],
				},
			},
		};
		expect(formReads(expression)).toEqual([
			{ node: { kind: "field", uuid: INNER }, kind: "cardinality" },
			{ node: { kind: "field", uuid: SOURCE }, kind: "value" },
		]);
	});

	it("gives an authored /data read the Vellum shadow its #form twin gets", () => {
		const { lower } = fixture();
		const read = (spelling?: "absolute"): Expression => ({
			kind: "term",
			term: {
				kind: "field",
				uuid: SOURCE,
				...(spelling === undefined ? {} : { spelling }),
			},
		});
		const runtime = { target: "xform", constraint: false } as const;
		const shadow = { target: "vellum", constraint: false } as const;
		const absolute = lower(read("absolute"));
		const hashtag = lower(read());
		expect(serializeWire(absolute, runtime).text).toBe(
			"/data/outer/item/source",
		);
		expect(serializeWire(hashtag, runtime).text).toBe(
			"/data/outer/item/source",
		);
		expect(serializeWire(absolute, shadow)?.text).toBe(
			"#form/outer/item/source",
		);
		expect(serializeWire(hashtag, shadow)?.text).toBe(
			"#form/outer/item/source",
		);
	});

	it("withholds the shadow of a filtered /data read exactly like its #form twin", () => {
		const { lower } = fixture();
		// The filtered read sits beside a plain `#form` read, which alone would
		// earn a shadow: only the filtered step's withholding keeps it absent.
		const read = (spelling?: "absolute"): Expression => ({
			kind: "arith",
			op: "+",
			left: {
				kind: "term",
				term: {
					kind: "field",
					uuid: SOURCE,
					...(spelling === undefined ? {} : { spelling }),
					filters: [{ step: { kind: "field", uuid: OUTER }, where: [truth] }],
				},
			},
			right: { kind: "term", term: { kind: "field", uuid: SOURCE } },
		});
		const runtime = { target: "xform", constraint: false } as const;
		const shadow = { target: "vellum", constraint: false } as const;
		const absolute = lower(read("absolute"));
		const hashtag = lower(read());
		expect(serializeWire(absolute, runtime).text).toBe(
			"/data/outer/item[true()]/source + /data/outer/item/source",
		);
		expect(serializeWire(hashtag, runtime).text).toBe(
			"/data/outer/item[true()]/source + /data/outer/item/source",
		);
		expect(serializeWire(absolute, shadow)).toBeUndefined();
		expect(serializeWire(hashtag, shadow)).toBeUndefined();
	});
});

describe("a form read inside a secondary instance's row predicate", () => {
	const ROW_FORM = testUuid("row-predicate-form");
	const REP = testUuid("row-predicate-rep");
	const Q = testUuid("row-predicate-q");
	const N = testUuid("row-predicate-n");
	const OTHER = testUuid("row-predicate-other");
	const X = testUuid("row-predicate-x");
	const LIMIT = testUuid("row-predicate-limit");
	const D = testUuid("row-predicate-d");
	const MODULE = testUuid("row-predicate-module");
	const LINK = testUuid("row-predicate-link");
	const read = (uuid: string): Expression => ({
		kind: "term",
		term: { kind: "field", uuid: uuid as never },
	});
	const dose: Expression = {
		kind: "term",
		term: { kind: "prop", caseType: "visit", property: "dose" },
	};
	const visits = (where: Expression): Expression => ({
		kind: "cases",
		source: "casedb",
		where: [
			{
				kind: "eq",
				left: { kind: "term", term: { kind: "case-row-type" } } as never,
				right: { kind: "term", term: { kind: "literal", value: "visit" } },
			},
			where,
		],
	});
	const counted = (where: Expression): Expression => ({
		kind: "count",
		via: visits(where),
	});
	const doseIs = (value: Expression): Expression => ({
		kind: "eq",
		left: dose,
		right: value,
	});

	function rowFixture() {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "visit",
					properties: [{ name: "dose", label: "Dose" }],
				},
			],
			modules: [
				{
					uuid: MODULE,
					name: "Visits",
					forms: [
						{
							uuid: ROW_FORM,
							name: "Rounds",
							type: "survey",
							formLinks: [
								{
									uuid: LINK,
									condition: truth,
									target: { type: "module", moduleUuid: MODULE },
								},
							],
							fields: [
								{ kind: "int", id: "limit", uuid: LIMIT },
								{
									kind: "repeat",
									id: "rep",
									uuid: REP,
									children: [
										{ kind: "text", id: "q", uuid: Q },
										{ kind: "text", id: "d", uuid: D },
										{
											kind: "hidden",
											id: "n",
											uuid: N,
											calculate: number(0),
										},
									],
								},
								{
									kind: "repeat",
									id: "other",
									uuid: OTHER,
									children: [{ kind: "text", id: "x", uuid: X }],
								},
							],
						},
					],
				},
			],
		});
		const form = formStructure(doc, ROW_FORM);
		if (form === undefined) throw new Error("The form fixture is incomplete.");
		const projection = formNodeProjection(doc, form);
		const lower = (
			expression: Expression,
			slot: SlotContextRef = {
				entity: "field",
				uuid: N,
				slot: "calculate",
			},
		) => {
			const types = slotContext(doc, slot, new Map());
			if (types === undefined)
				throw new Error("The form fixture slot is missing.");
			return toWire(expression, { target: "xform", types, form: projection });
		};
		return {
			lower,
			text: (expression: Expression, slot?: SlotContextRef) =>
				serializeWire(lower(expression, slot), {
					target: "xform",
					constraint: false,
				}).text,
			shadow: (expression: Expression, slot?: SlotContextRef) =>
				serializeWire(lower(expression, slot), {
					target: "vellum",
					constraint: false,
				})?.text,
		};
	}

	it("reads the entry's own answer as current() where the read crosses the slot's repeat", () => {
		const { text, shadow } = rowFixture();
		const expression = counted(doseIs(read(Q)));
		expect(text(expression)).toBe(
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][dose = current()/../q])",
		);
		// That was the expression's only hashtag form read, so Vellum keeps
		// no shadow of it.
		expect(shadow(expression)).toBeUndefined();
	});

	it("keeps a sibling root read's shadow beside the current() read", () => {
		const { text, shadow } = rowFixture();
		const expression: Expression = {
			kind: "gt",
			left: counted(doseIs(read(Q))),
			right: read(LIMIT),
		};
		expect(text(expression)).toBe(
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][dose = current()/../q]) > /data/limit",
		);
		expect(shadow(expression)).toBe(
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][dose = current()/../q]) > #form/limit",
		);
	});

	it("reads current()/q in the repeat's own relevant", () => {
		const { text } = rowFixture();
		expect(
			text(
				{ kind: "gt", left: counted(doseIs(read(Q))), right: number(0) },
				{ entity: "field", uuid: REP, slot: "relevant" },
			),
		).toBe(
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][dose = current()/q]) > 0",
		);
	});

	it("keeps the bytes of a read that crosses no repeat the slot is in, or sits outside a predicate", () => {
		const { text } = rowFixture();
		expect(text(counted(doseIs(read(LIMIT))))).toBe(
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][dose = /data/limit])",
		);
		expect(text(counted(doseIs(read(X))))).toBe(
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][dose = /data/other/x])",
		);
		expect(text(doseIs(read(Q)))).not.toContain("current()");
	});

	it("keeps the bytes of a read inside a form repeat's filter", () => {
		// A form step's filter changes only the context node; no secondary
		// instance's row is active, so the read names its one node already.
		const { text } = rowFixture();
		const expression: Expression = {
			kind: "count",
			via: {
				kind: "term",
				term: {
					kind: "field",
					uuid: OTHER,
					filters: [
						{
							step: { kind: "field", uuid: OTHER },
							where: [
								{
									kind: "eq",
									left: {
										kind: "term",
										term: { kind: "field", uuid: X, spelling: "relative" },
									},
									right: read(Q),
								},
							],
						},
					],
				},
			},
		};
		expect(text(expression)).toBe("count(/data/other[x = /data/rep/q])");
	});

	it("keeps the bytes of a read in a form link's condition, which has no source node", () => {
		const { text } = rowFixture();
		expect(
			text(counted(doseIs(read(Q))), {
				entity: "form",
				uuid: ROW_FORM,
				slot: "form_link_condition",
				member: { linkUuid: LINK },
			}),
		).toBe(
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][dose = /data/rep/q])",
		);
	});

	it("leaves a default value's reads anchored at current() as before", () => {
		const { text } = rowFixture();
		const slot = { entity: "field", uuid: D, slot: "default_value" } as const;
		expect(text(counted(doseIs(read(Q))), slot)).toBe(
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][dose = current()/../q])",
		);
		expect(text(counted(doseIs(read(LIMIT))), slot)).toBe(
			"count(instance('casedb')/casedb/case[@case_type = 'visit'][dose = current()/../../limit])",
		);
	});
});
