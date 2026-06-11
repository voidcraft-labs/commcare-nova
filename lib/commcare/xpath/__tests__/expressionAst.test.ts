/**
 * Leaf classification + resolve-at-print semantics for the expression
 * AST: which textual shapes mint identity leaves, that prints follow
 * renames/moves with no slot rewrite, and that the structural
 * case-property leaf rename matches the long-standing rewriter rules.
 */
import { describe, expect, it } from "vitest";
import {
	cloneXPathExpression,
	fieldPathResolver,
	printXPath,
	renameCasePropertyInXPath,
	type XPathExpression,
	type XPathPrintableDoc,
	xpathPrintContext,
} from "@/lib/domain";
import { parseXPathExpression } from "../expressionAst";

const FORM = "form-1";

function makeDoc(): XPathPrintableDoc {
	return {
		forms: { [FORM]: {} },
		fields: {
			"f-age": { id: "age" },
			"f-grp": { id: "grp" },
			"f-inner": { id: "inner" },
		},
		fieldOrder: {
			[FORM]: ["f-age", "f-grp"],
			"f-grp": ["f-inner"],
		},
	};
}

function parse(source: string, doc: XPathPrintableDoc): XPathExpression {
	return parseXPathExpression(source, fieldPathResolver(doc, FORM));
}

describe("leaf classification", () => {
	it("resolves #form refs to field-ref leaves, full path only", () => {
		const doc = makeDoc();
		expect(parse("#form/age", doc).parts).toEqual([
			{ kind: "field-ref", uuid: "f-age" },
		]);
		expect(parse("#form/grp/inner", doc).parts).toEqual([
			{ kind: "field-ref", uuid: "f-inner" },
		]);
		// A bare leaf id nested under a group does NOT resolve from the
		// form root — it stays raw, the dangling treatment.
		expect(parse("#form/inner", doc).parts).toEqual([
			{ kind: "raw-ref", namespace: "form", segments: ["inner"] },
		]);
	});

	it("resolves pure /data chains to path-ref leaves with verbatim separators", () => {
		const doc = makeDoc();
		expect(parse("/data/grp/inner", doc).parts).toEqual([
			{ kind: "path-ref", uuid: "f-inner", seps: ["/", "/", "/"] },
		]);
		expect(parse("/ data / age", doc).parts).toEqual([
			{ kind: "path-ref", uuid: "f-age", seps: ["/ ", " / "] },
		]);
		expect(parse("//data//age", doc).parts).toEqual([
			{ kind: "path-ref", uuid: "f-age", seps: ["//", "//"] },
		]);
	});

	it("keeps impure chains as text, claiming only the nested pure prefix", () => {
		const doc = makeDoc();
		const parts = parse("/data/grp[1]/inner", doc).parts;
		expect(parts).toEqual([
			{ kind: "path-ref", uuid: "f-grp", seps: ["/", "/"] },
			{ kind: "text", text: "[1]/inner" },
		]);
	});

	it("classifies case, user, contextual, and unknown namespaces", () => {
		const doc = makeDoc();
		expect(parse("#mother/age", doc).parts).toEqual([
			{ kind: "case-ref", caseType: "mother", property: "age" },
		]);
		expect(parse("#user/role", doc).parts).toEqual([
			{ kind: "user-ref", property: "role" },
		]);
		expect(parse("#case/age", doc).parts).toEqual([
			{ kind: "raw-ref", namespace: "case", segments: ["age"] },
		]);
		expect(parse("#mother/a/b", doc).parts).toEqual([
			{ kind: "raw-ref", namespace: "mother", segments: ["a", "b"] },
		]);
	});

	it("parses a syntax-broken source to one opaque text run", () => {
		const doc = makeDoc();
		expect(parse("if(#form/age", doc).parts).toEqual([
			{ kind: "text", text: "if(#form/age" },
		]);
	});

	it("parses the empty string to the empty expression", () => {
		expect(parse("", makeDoc()).parts).toEqual([]);
	});
});

describe("resolve at print", () => {
	it("prints the target's CURRENT name after a rename — no rewrite", () => {
		const doc = makeDoc();
		const expr = parse("#form/age > 18 and /data/age != ''", doc);
		const fields = doc.fields as Record<string, { id: string }>;
		fields["f-age"].id = "years";
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#form/years > 18 and /data/years != ''",
		);
	});

	it("re-anchors across a depth change, padding separators with /", () => {
		const doc = makeDoc();
		const expr = parse("#form/age + /data/age", doc);
		// Move `age` into the group.
		const order = doc.fieldOrder as Record<string, string[]>;
		order[FORM] = ["f-grp"];
		order["f-grp"] = ["f-age", "f-inner"];
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#form/grp/age + /data/grp/age",
		);
	});

	it("prints a container rename through refs to its descendants", () => {
		const doc = makeDoc();
		const expr = parse("#form/grp/inner", doc);
		(doc.fields as Record<string, { id: string }>)["f-grp"].id = "section";
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#form/section/inner",
		);
	});

	it("prints raw and case leaves verbatim regardless of doc changes", () => {
		const doc = makeDoc();
		const expr = parse("#form/gone + #mother/age + #case/age", doc);
		(doc.fields as Record<string, { id: string }>)["f-age"].id = "years";
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#form/gone + #mother/age + #case/age",
		);
	});

	it("falls back to the uuid spelling for an unresolvable identity leaf", () => {
		const doc = makeDoc();
		const expr = parse("#form/age", doc);
		delete (doc.fields as Record<string, unknown>)["f-age"];
		expect(printXPath(expr, xpathPrintContext(doc))).toBe("#form/f-age");
	});
});

describe("structural case-property rename", () => {
	it("renames matching case-ref leaves and contextual raw leaves", () => {
		const doc = makeDoc();
		const expr = parse("#mother/age + #case/age + #other/age", doc);
		const renamed = renameCasePropertyInXPath(
			expr,
			{ caseType: "mother", oldName: "age", newName: "years" },
			{ contextualMatches: true },
		);
		expect(renamed).toBe(2);
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#mother/years + #case/years + #other/age",
		);
	});

	it("leaves contextual refs alone when the carrier's module type differs", () => {
		const doc = makeDoc();
		const expr = parse("#case/age", doc);
		const renamed = renameCasePropertyInXPath(
			expr,
			{ caseType: "mother", oldName: "age", newName: "years" },
			{ contextualMatches: false },
		);
		expect(renamed).toBe(0);
		expect(printXPath(expr, xpathPrintContext(doc))).toBe("#case/age");
	});

	it("never touches multi-segment contextual refs", () => {
		const doc = makeDoc();
		const expr = parse("#case/parent/age", doc);
		const renamed = renameCasePropertyInXPath(
			expr,
			{ caseType: "mother", oldName: "age", newName: "years" },
			{ contextualMatches: true },
		);
		expect(renamed).toBe(0);
	});
});

describe("clone", () => {
	it("copies leaves verbatim — a clone keeps pointing at the original target", () => {
		const doc = makeDoc();
		const expr = parse("#form/age + #mother/age", doc);
		const clone = cloneXPathExpression(expr);
		expect(clone).toEqual(expr);
		expect(clone).not.toBe(expr);
		expect(clone.parts[0]).not.toBe(expr.parts[0]);
	});
});
