/**
 * The reader's print of a slot with a rewrite control: the emitter's own
 * print where the control withholds nothing, the print from before a
 * rewrite where it withholds that rewrite, and a report of every site the
 * print reaches. The failures this holds: a byte of the emitter's print
 * changed by the control's presence; a withheld rewrite still printed; a
 * site reached and not reported; a relocation site that reports only where
 * the tree stores an absolute read.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { EmissionRewriteId } from "@/lib/commcare/emissionRewrites";
import type { Expression, SlotContextRef } from "@/lib/domain/expression/types";
import { sameXPathText } from "../../syntaxCompare";
import { printSlot } from "../readExpression";
import { fieldNamed, readEnv } from "./expressionReadFixture";

function surveyDoc() {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							f({ kind: "datetime", id: "start", label: "Start" }),
							f({ kind: "datetime", id: "end", label: "End" }),
							f({ kind: "text", id: "q1", label: "Q1" }),
						],
					},
				],
			},
		],
	});
}

function field(uuid: string, spelling?: "current" | "absolute"): Expression {
	return {
		kind: "term",
		term: {
			kind: "field",
			uuid: uuid as never,
			...(spelling === undefined ? {} : { spelling }),
		},
	};
}

function printed(
	doc: ReturnType<typeof surveyDoc>,
	ref: SlotContextRef,
	expression: Expression,
	withhold?: readonly EmissionRewriteId[],
) {
	const reached: EmissionRewriteId[] = [];
	const text = printSlot(doc, ref, expression, readEnv(), {
		...(withhold === undefined
			? {}
			: {
					rewrites: {
						withhold: new Set(withhold),
						reached: (id) => reached.push(id),
					},
				}),
	});
	return { text, reached };
}

describe("a print under a rewrite control", () => {
	it("prints the emitter's own bytes where the control withholds nothing", () => {
		const doc = surveyDoc();
		const start = fieldNamed(doc, "start");
		const end = fieldNamed(doc, "end");
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const comparison: Expression = {
			kind: "lt",
			left: field(start),
			right: field(end),
		};
		const own = printed(doc, ref, comparison);
		const controlled = printed(doc, ref, comparison, []);
		expect(controlled.text).toBe(own.text);
		expect(controlled.reached).toContain("instant-comparison");
	});

	it("prints a withheld instant comparison as the bare comparison", () => {
		const doc = surveyDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "q1"),
			slot: "relevant",
		} as const;
		const comparison: Expression = {
			kind: "lt",
			left: field(fieldNamed(doc, "start")),
			right: field(fieldNamed(doc, "end")),
		};
		const lowered = printed(doc, ref, comparison, []);
		const withheld = printed(doc, ref, comparison, ["instant-comparison"]);
		expect(
			sameXPathText(withheld.text, "/data/start < /data/end", {
				ruleSet: "form",
			}),
		).toBe(true);
		expect(
			sameXPathText(lowered.text, withheld.text, { ruleSet: "form" }),
		).toBe(false);
		expect(withheld.reached).toContain("instant-comparison");
	});

	it("reports a default's relocation whatever spelling the read stores", () => {
		const doc = surveyDoc();
		const ref = {
			entity: "field",
			uuid: fieldNamed(doc, "end"),
			slot: "default_value",
		} as const;
		const start = fieldNamed(doc, "start");
		for (const spelling of [undefined, "absolute", "current"] as const) {
			const unwithheld = printed(doc, ref, field(start, spelling), []);
			expect(unwithheld.reached).toContain("default-reads-current");
			const withheld = printed(doc, ref, field(start, spelling), [
				"default-reads-current",
			]);
			expect(withheld.reached).toContain("default-reads-current");
			expect(withheld.text).not.toBe(unwithheld.text);
		}
	});
});
