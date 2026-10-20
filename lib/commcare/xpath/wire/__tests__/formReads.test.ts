import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { slotContext } from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type {
	Expression,
	FieldExpressionSlotRef,
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
