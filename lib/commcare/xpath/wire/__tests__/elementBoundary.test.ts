import { expect, it } from "vitest";
import { el, type WireElementContext, xel } from "../../../elementBuilders";
import { serializeXml } from "../../../serializeXml";
import {
	legacyProjectedAuthoredXPath,
	legacyProjectedFormLinkXPath,
	legacyXPathInstances,
} from "../../../xform/legacyAuthoredXPath";
import { parseXml } from "../../../xmlParse";
import { w } from "../builders";
import { caseDbInstance, InstanceSink } from "../instances";

function context(): WireElementContext {
	return {
		mode: { target: "xform", constraint: false },
		instances: new InstanceSink(),
		resolveLegacyInstances: legacyXPathInstances,
	};
}

it("encodes XPath only once as XML and preserves literal character data", () => {
	const value = "<tag>&\"'\t\n\r";
	const output = xel("output", { xpath: { value: w.str(value) } }, context());
	const xml = serializeXml(output);
	const parsed = parseXml(xml).children[0];
	expect(parsed).toHaveProperty("attribs.value", output.attribs.value);
	expect(xml).toContain("&amp;");
	expect(xml).toContain("&#x9;");
	expect(xml).toContain("&#xa;");
	expect(xml).toContain("&#xd;");
});

it("takes each bind attribute's mode and omits a withheld Vellum shadow", () => {
	const predicate = w.form([
		w.step("answers", [w.eq(w.context(), w.str("yes"))]),
	]);
	const expr = w.expansion(
		"case",
		w.instance(caseDbInstance(), [w.step("casedb")]),
	);
	const ctx = context();
	const bind = xel(
		"bind",
		{
			xpath: {
				nodeset: w.form(["answer"]),
				constraint: predicate,
				calculate: predicate,
				"vellum:calculate": expr,
			},
		},
		ctx,
	);
	expect(bind.attribs.constraint).toBe("/data/answers[. = 'yes']");
	expect(bind.attribs.calculate).toBe("/data/answers[./. = 'yes']");
	expect(bind.attribs).not.toHaveProperty("vellum:calculate");
	expect(ctx.instances.declarations()).toEqual([]);
});

it("collects generated and temporary authored reads in one scope without ambient instances", () => {
	const ctx = context();
	xel(
		"bind",
		{
			xpath: {
				nodeset: w.form(["answer"]),
				calculate: w.instance(caseDbInstance(), [w.step("casedb")]),
			},
		},
		ctx,
	);
	xel(
		"bind",
		{
			xpath: { nodeset: w.form(["other"]) },
			authoredXPath: {
				relevant: legacyProjectedAuthoredXPath(
					"instance('commcaresession')/session/data/case_id != ''",
				),
			},
		},
		ctx,
	);
	expect(ctx.instances.declarations().map(({ id }) => id)).toEqual([
		"casedb",
		"commcaresession",
	]);
});

it("keeps the form-link bridge confined to stack conditions and datum values", () => {
	const ctx: WireElementContext = {
		mode: { target: "suite" },
		instances: new InstanceSink(),
		resolveLegacyInstances: legacyXPathInstances,
	};
	const link = legacyProjectedFormLinkXPath(
		"instance('commcaresession')/session/data/case_id",
	);
	expect(
		xel(
			"datum",
			{ attributes: { id: "case_id" }, legacyFormLinkXPath: { value: link } },
			ctx,
		).attribs.value,
	).toBe(link.text);
	expect(ctx.instances.declarations().map(({ id }) => id)).toEqual([
		"commcaresession",
	]);
	expect(() => {
		// @ts-expect-error A form-link expression is not an XForm calculation.
		xel("bind", { legacyFormLinkXPath: { calculate: link } }, ctx);
	}).toThrow("legacy authored slot");
});

it("refuses string XPath, duplicate carriers and a missing legacy resolver", () => {
	expect(() => {
		// @ts-expect-error A raw XML builder cannot accept executable strings.
		el("bind", { calculate: "1 + 2" });
	}).toThrow("requires an XPath tree");
	expect(() => {
		// @ts-expect-error Executable XML maps accept WireExpr only.
		xel("output", { xpath: { value: "'text'" } }, context());
	}).toThrow();
	expect(() =>
		xel(
			"output",
			{
				xpath: { value: w.str("one") },
				authoredXPath: { value: legacyProjectedAuthoredXPath("'two'") },
			},
			context(),
		),
	).toThrow("more than once");
	expect(() =>
		xel(
			"output",
			{ authoredXPath: { value: legacyProjectedAuthoredXPath("'text'") } },
			{
				mode: { target: "xform", constraint: false },
				instances: new InstanceSink(),
			},
		),
	).toThrow("instance resolver");
	// The stack query's value is a URL, not executable XPath.
	expect(
		el("query", { value: "https://example.org/query" }).attribs.value,
	).toBe("https://example.org/query");
});
