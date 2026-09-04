/**
 * Leaf classification + resolve-at-print semantics for the expression
 * AST: which textual shapes mint identity leaves, that prints follow
 * renames/moves with no slot rewrite, and that the structural
 * case-property leaf rename matches the long-standing rewriter rules.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolvableUserPropertySlug } from "@/lib/doc/expressionText";
import {
	fieldPathResolver,
	printXPath,
	projectXPath,
	renameCasePropertyInXPath,
	type XPathExpression,
	type XPathPrintableDoc,
	XPathProjectionError,
	xpathPrintContext,
} from "@/lib/domain";
import {
	parseXPathExpression,
	parseXPathExpressionWithIssues,
} from "../expressionAst";

const FORM = testUuid("form-1");
const AGE = testUuid("f-age");
const GROUP = testUuid("f-grp");
const INNER = testUuid("f-inner");
const REGION = testUuid("property-region");

function makeDoc(): XPathPrintableDoc {
	return {
		forms: { [FORM]: {} },
		fields: {
			[AGE]: { id: "age" },
			[GROUP]: { id: "grp" },
			[INNER]: { id: "inner" },
		},
		fieldOrder: {
			[FORM]: [AGE, GROUP],
			[GROUP]: [INNER],
		},
		userProperties: {
			[REGION]: { slug: "region" },
		},
	};
}

function parse(source: string, doc: XPathPrintableDoc): XPathExpression {
	return parseXPathExpression(
		source,
		fieldPathResolver(doc, FORM),
		resolvableUserPropertySlug(doc),
	);
}

describe("leaf classification", () => {
	it("resolves #form refs to field-ref leaves, full path only", () => {
		const doc = makeDoc();
		expect(parse("#form/age", doc).parts).toEqual([
			{ kind: "field-ref", uuid: AGE },
		]);
		expect(parse("#form/grp/inner", doc).parts).toEqual([
			{ kind: "field-ref", uuid: INNER },
		]);
		// A bare leaf id nested under a group does NOT resolve from the
		// form root. No mutable raw-reference leaf is admitted.
		expect(parse("#form/inner", doc).parts).toEqual([
			{ kind: "text", text: "#form/inner" },
		]);
	});

	it("resolves pure /data chains to canonical path-ref leaves", () => {
		const doc = makeDoc();
		expect(parse("/data/grp/inner", doc).parts).toEqual([
			{ kind: "path-ref", uuid: INNER },
		]);
		expect(parse("/ data / age", doc).parts).toEqual([
			{ kind: "path-ref", uuid: AGE },
		]);
		expect(parse("//data//age", doc).parts).toEqual([
			{ kind: "text", text: "//data//age" },
		]);
		expect(printXPath(parse("//data//age", doc), xpathPrintContext(doc))).toBe(
			"//data//age",
		);
	});

	it("keeps impure chains as text, claiming only the nested pure prefix", () => {
		const doc = makeDoc();
		const parts = parse("/data/grp[1]/inner", doc).parts;
		expect(parts).toEqual([
			{ kind: "path-ref", uuid: GROUP },
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
			{ kind: "text", text: "#case/age" },
		]);
		expect(parse("#mother/a/b", doc).parts).toEqual([
			{ kind: "text", text: "#mother/a/b" },
		]);
	});

	it("rejects raw #case authoring instead of minting a contextual identity", () => {
		const doc = makeDoc();
		const parsed = parseXPathExpressionWithIssues(
			"#case/age",
			fieldPathResolver(doc, FORM),
			resolvableUserPropertySlug(doc),
		);
		expect(parsed.expression.parts).toEqual([
			{ kind: "text", text: "#case/age" },
		]);
		expect(parsed.issues).toEqual([
			{
				kind: "unresolved-reference",
				source: "#case/age",
				from: 0,
				to: 9,
			},
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
	it("stores #form identity while the editor projects only the current friendly id", () => {
		const doc = makeDoc();
		(doc.fields as Record<string, { id: string }>)[AGE].id = "first_name";
		const expr = parse("#form/first_name != ''", doc);

		expect(expr.parts).toEqual([
			{ kind: "field-ref", uuid: AGE },
			{ kind: "text", text: " != ''" },
		]);
		const stored = structuredClone(expr);
		const before = projectXPath(expr, xpathPrintContext(doc));
		expect(before).toEqual({ ok: true, text: "#form/first_name != ''" });
		if (before.ok) expect(before.text).not.toContain(AGE);

		(doc.fields as Record<string, { id: string }>)[AGE].id = "given_name";
		expect(expr).toEqual(stored);
		const after = projectXPath(expr, xpathPrintContext(doc));
		expect(after).toEqual({ ok: true, text: "#form/given_name != ''" });
		if (after.ok) expect(after.text).not.toContain(AGE);
	});

	it("resolves a UUID-looking friendly field id by path, not by identity text", () => {
		const doc = makeDoc();
		const uuidLookingId = testUuid("friendly-looking-id");
		(doc.fields as Record<string, { id: string }>)[AGE].id = uuidLookingId;

		const expr = parse(`#form/${uuidLookingId}`, doc);
		expect(expr.parts).toEqual([{ kind: "field-ref", uuid: AGE }]);
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			`#form/${uuidLookingId}`,
		);
	});

	it("prints the target's CURRENT name after a rename — no rewrite", () => {
		const doc = makeDoc();
		const expr = parse("#form/age > 18 and /data/age != ''", doc);
		const fields = doc.fields as Record<string, { id: string }>;
		fields[AGE].id = "years";
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#form/years > 18 and /data/years != ''",
		);
	});

	it("re-anchors across a depth change, padding separators with /", () => {
		const doc = makeDoc();
		const expr = parse("#form/age + /data/age", doc);
		// Move `age` into the group.
		const order = doc.fieldOrder as Record<string, string[]>;
		order[FORM] = [GROUP];
		order[GROUP] = [AGE, INNER];
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#form/grp/age + /data/grp/age",
		);
	});

	it("prints a container rename through refs to its descendants", () => {
		const doc = makeDoc();
		const expr = parse("#form/grp/inner", doc);
		(doc.fields as Record<string, { id: string }>)[GROUP].id = "section";
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#form/section/inner",
		);
	});

	it("prints raw and case leaves verbatim regardless of doc changes", () => {
		const doc = makeDoc();
		const expr = parse("#form/gone + #mother/age + #case/age", doc);
		(doc.fields as Record<string, { id: string }>)[AGE].id = "years";
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#form/gone + #mother/age + #case/age",
		);
	});

	it("shows repair text without leaking identity and blocks strict projection", () => {
		const doc = makeDoc();
		const expr = parse("#form/age", doc);
		delete (doc.fields as Record<string, unknown>)[AGE];
		const projected = projectXPath(expr, xpathPrintContext(doc));
		expect(projected).toEqual({
			ok: false,
			text: "#form/[reference needs repair]",
			unresolved: [{ kind: "field-ref", identity: AGE }],
		});
		expect(projected.text).not.toContain(AGE);
		expect(() => printXPath(expr, xpathPrintContext(doc))).toThrow(
			XPathProjectionError,
		);
	});

	it("prints a custom user property through its current slug without rewriting", () => {
		const doc = makeDoc();
		const expr = parse("#user/region + #user/commcare_project", doc);
		expect(expr.parts).toEqual([
			{
				kind: "user-property-ref",
				userPropertyUuid: REGION,
			},
			{ kind: "text", text: " + " },
			{ kind: "user-ref", property: "commcare_project" },
		]);

		doc.userProperties = {
			[REGION]: { slug: "district" },
		};
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#user/district + #user/commcare_project",
		);
	});

	it("keeps the already-shipped raw user-ref final and name-based", () => {
		const doc = makeDoc();
		const expr: XPathExpression = {
			parts: [{ kind: "user-ref", property: "region" }],
		};
		doc.userProperties = {
			[REGION]: { slug: "district" },
		};
		expect(printXPath(expr, xpathPrintContext(doc))).toBe("#user/region");
	});

	it("does not bind a malformed duplicate slug to an arbitrary uuid", () => {
		const doc = makeDoc();
		doc.userProperties = {
			[testUuid("first")]: { slug: "region" },
			[testUuid("second")]: { slug: "region" },
		};
		expect(parse("#user/region", doc).parts).toEqual([
			{ kind: "user-ref", property: "region" },
		]);
	});

	it("keeps built-in names raw when an invalid custom property collides", () => {
		const doc = makeDoc();
		doc.userProperties = {
			[testUuid("invalid-built-in-collision")]: { slug: "user_type" },
		};
		expect(parse("#user/user_type", doc).parts).toEqual([
			{ kind: "user-ref", property: "user_type" },
		]);
	});

	it("keeps invalid reserved custom-property names raw", () => {
		const doc = makeDoc();
		doc.userProperties = {
			[testUuid("invalid-reserved-collision")]: { slug: "case_id" },
		};
		expect(parse("#user/case_id", doc).parts).toEqual([
			{ kind: "user-ref", property: "case_id" },
		]);
	});

	it("keeps a case-insensitive duplicate raw even when one spelling matches exactly", () => {
		const doc = makeDoc();
		doc.userProperties = {
			[testUuid("upper")]: { slug: "Region" },
			[testUuid("lower")]: { slug: "region" },
		};
		const expr = parse("#user/region", doc);
		expect(expr.parts).toEqual([{ kind: "user-ref", property: "region" }]);

		doc.userProperties = {
			[testUuid("upper")]: { slug: "Region" },
			[testUuid("lower")]: { slug: "district" },
		};
		expect(printXPath(expr, xpathPrintContext(doc))).toBe("#user/region");
	});

	it("requires exact capitalization even for one unambiguous custom identity", () => {
		const doc = makeDoc();
		doc.userProperties = {
			[testUuid("upper")]: { slug: "Region" },
		};
		const expr = parse("#user/region", doc);
		expect(expr.parts).toEqual([{ kind: "user-ref", property: "region" }]);

		doc.userProperties = {
			[testUuid("upper")]: { slug: "District" },
		};
		expect(printXPath(expr, xpathPrintContext(doc))).toBe("#user/region");
	});
});

describe("#search/ answers", () => {
	const MODULE = testUuid("mod-patients");
	const NAME_INPUT = testUuid("input-patient-name");

	function docWithSearch(): XPathPrintableDoc {
		return {
			...makeDoc(),
			modules: {
				[MODULE]: {
					caseListConfig: {
						searchInputs: [{ uuid: NAME_INPUT, name: "patient_name" }],
					},
				},
			},
		};
	}

	it("binds #search/<name> to a search-answer-ref only through the resolver", () => {
		const doc = docWithSearch();
		const bound = parseXPathExpression(
			"#search/patient_name",
			fieldPathResolver(doc, FORM),
			resolvableUserPropertySlug(doc),
			(name) => (name === "patient_name" ? NAME_INPUT : undefined),
		);
		expect(bound.parts).toEqual([
			{ kind: "search-answer-ref", searchInputUuid: NAME_INPUT },
		]);
		expect(printXPath(bound, xpathPrintContext(doc))).toBe(
			"#search/patient_name",
		);

		// Without a resolver (every form but a no-matches one) the text stays
		// inert and the parse reports the unresolved reference.
		const unbound = parseXPathExpressionWithIssues(
			"#search/patient_name",
			fieldPathResolver(doc, FORM),
			resolvableUserPropertySlug(doc),
		);
		expect(unbound.expression.parts).toEqual([
			{ kind: "text", text: "#search/patient_name" },
		]);
		expect(unbound.issues).toEqual([
			{
				kind: "unresolved-reference",
				source: "#search/patient_name",
				from: 0,
				to: 20,
			},
		]);
	});

	it("prints the prompt's CURRENT name and repairs a removed prompt", () => {
		const doc = docWithSearch();
		const expr: XPathExpression = {
			parts: [{ kind: "search-answer-ref", searchInputUuid: NAME_INPUT }],
		};
		const modules = doc.modules as Record<
			string,
			{ caseListConfig: { searchInputs: { uuid: string; name: string }[] } }
		>;
		modules[MODULE].caseListConfig.searchInputs[0].name = "client_name";
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#search/client_name",
		);

		modules[MODULE].caseListConfig.searchInputs = [];
		expect(projectXPath(expr, xpathPrintContext(doc))).toEqual({
			ok: false,
			text: "#search/[reference needs repair]",
			unresolved: [{ kind: "search-answer-ref", identity: NAME_INPUT }],
		});
	});
});

describe("structural case-property rename", () => {
	it("renames only the explicit identity and never rejected raw #case text", () => {
		const doc = makeDoc();
		const expr = parse("#mother/age + #case/age + #other/age", doc);
		const renamed = renameCasePropertyInXPath(expr, {
			caseType: "mother",
			oldName: "age",
			newName: "years",
		});
		expect(renamed).toBe(1);
		expect(printXPath(expr, xpathPrintContext(doc))).toBe(
			"#mother/years + #case/age + #other/age",
		);
	});
});
