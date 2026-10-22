import { expect, it } from "vitest";
import { el, type WireElementContext, xel } from "../../../elementBuilders";
import { serializeXml } from "../../../serializeXml";
import { parseXml } from "../../../xmlParse";
import { w } from "../builders";
import { caseDbInstance, InstanceSink, sessionInstance } from "../instances";

function context(): WireElementContext {
	return {
		mode: { target: "xform", constraint: false },
		instances: new InstanceSink(),
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

it("collects every emitted tree's reads in its owning scope without ambient instances", () => {
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
			xpath: {
				nodeset: w.form(["other"]),
				relevant: w.ne(
					w.instance(sessionInstance(), [
						w.step("session"),
						w.step("data"),
						w.step("case_id"),
					]),
					w.str(""),
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

it("prints a form-link datum through the same tree and instance boundary", () => {
	const ctx: WireElementContext = {
		mode: { target: "suite" },
		instances: new InstanceSink(),
	};
	const link = w.instance(sessionInstance(), [
		w.step("session"),
		w.step("data"),
		w.step("case_id"),
	]);
	expect(
		xel("datum", { attributes: { id: "case_id" }, xpath: { value: link } }, ctx)
			.attribs.value,
	).toBe("instance('commcaresession')/session/data/case_id");
	expect(ctx.instances.declarations().map(({ id }) => id)).toEqual([
		"commcaresession",
	]);
});

it("refuses executable strings at raw and typed attribute boundaries", () => {
	expect(() => {
		// @ts-expect-error A raw XML builder cannot accept executable strings.
		el("bind", { calculate: "1 + 2" });
	}).toThrow("requires an XPath tree");
	expect(() => {
		// @ts-expect-error Executable XML maps accept WireExpr only.
		xel("output", { xpath: { value: "'text'" } }, context());
	}).toThrow();
	// The stack query's value is a URL, not executable XPath.
	expect(
		el("query", { value: "https://example.org/query" }).attribs.value,
	).toBe("https://example.org/query");
});
