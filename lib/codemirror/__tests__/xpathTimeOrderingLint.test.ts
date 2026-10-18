/**
 * The inline linter underlines an ordering on a time of day with the
 * validator's own sentence, read by the validator's own function over the
 * document the context was built from. The plausible failures: the editor
 * accepting a comparison the commit gate then refuses, and the underline
 * landing anywhere but the comparison.
 */

import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { TIME_ORDERING_MESSAGE } from "@/lib/domain/expression/ruleSets";
import { proseText } from "@/lib/domain/prose";
import { buildExpressionLintContext } from "../buildLintContext";
import { xpathDiagnostics } from "../xpath-lint";

function context() {
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							{ id: "start", kind: "time", label: proseText("Start") },
							{ id: "end", kind: "time", label: proseText("End") },
							{ id: "visit_day", kind: "date", label: proseText("Day") },
						],
					},
				],
			},
		],
	});
	const field = Object.values(doc.fields).find((entry) => entry.id === "end");
	if (field === undefined) throw new Error("Missing field fixture");
	const ctx = buildExpressionLintContext(
		doc,
		{ entity: "field", uuid: field.uuid, slot: "relevant" },
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (ctx === undefined) throw new Error("Missing lint context");
	return ctx;
}

describe("xpathDiagnostics: ordering a time of day", () => {
	it("underlines the comparison with the validator's sentence", () => {
		const expr = "#form/start < #form/end";
		expect(xpathDiagnostics(expr, context())).toEqual([
			{
				from: 0,
				to: expr.length,
				severity: "error",
				message: TIME_ORDERING_MESSAGE,
			},
		]);
	});

	it("underlines what was typed where a reference prints at another length", () => {
		// `/data/ start` is stored as the reference `/data/start`, one
		// character shorter, so a span of the printed text would land one
		// character early on the second comparison.
		const expr = "/data/ start < 3 and #form/end > 2";
		expect(xpathDiagnostics(expr, context())).toEqual([
			{
				from: 0,
				to: "/data/ start < 3".length,
				severity: "error",
				message: TIME_ORDERING_MESSAGE,
			},
			{
				from: expr.indexOf("#form/end"),
				to: expr.length,
				severity: "error",
				message: TIME_ORDERING_MESSAGE,
			},
		]);
	});

	it("passes a time compared with = and a date ordered", () => {
		const ctx = context();
		expect(xpathDiagnostics("#form/start = #form/end", ctx)).toEqual([]);
		expect(xpathDiagnostics("#form/visit_day > today()", ctx)).toEqual([]);
	});
});
