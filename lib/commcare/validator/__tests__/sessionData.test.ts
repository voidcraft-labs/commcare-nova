/** Session names bind at parse time; saved reads retain domain entry identity. */
import { describe, expect, it } from "vitest";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	formFixture,
	ids,
} from "@/lib/domain/expression/__tests__/formFixture";
import type { Expression } from "@/lib/domain/expression/types";
import { runValidation } from "../runner";

const selectedCase: Expression = {
	kind: "term",
	term: {
		kind: "session-datum",
		datum: { kind: "selected-case", module: ids.module },
	},
};
const newCase: Expression = {
	kind: "term",
	term: { kind: "session-datum", datum: { kind: "new-case" } },
};
const slot = { entity: "field", uuid: ids.hidden, slot: "calculate" } as const;
function readDoc(expression: Expression) {
	const doc = formFixture();
	const hidden = doc.fields[ids.hidden];
	if (hidden.kind !== "hidden")
		throw new Error("The calculated fixture is missing.");
	hidden.calculate = expression;
	return doc;
}

describe("session datum admission", () => {
	it.each([
		{
			source: "instance('commcaresession')/session/data/supply_point_id",
			code: "unknown-datum",
		},
		{
			source: "count(instance('commcaresession')/session/data/*)",
			code: "wildcard",
		},
	])(
		"refuses an unbound session path before storing it: $source",
		({ source, code }) => {
			const parsed = parseFormExpression(source, {
				doc: formFixture(),
				slot,
				lookup: "unavailable",
			});
			expect(parsed).toMatchObject({
				ok: false,
				issues: [expect.objectContaining({ code })],
			});
		},
	);
	it("accepts the selected-case identity in a follow-up form", () => {
		expect(
			runValidation(readDoc(selectedCase), LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual([]);
	});
	it("refuses a saved selection when the form no longer opens with one", () => {
		const doc = readDoc(selectedCase);
		doc.forms[ids.form].type = "survey";
		delete doc.forms[ids.form].formLinks;
		const findings = runValidation(
			structuredClone(doc),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			code: "SESSION_DATUM_NOT_SUPPLIED",
			location: { fieldId: "hidden", field: "calculate", formName: "Visit" },
			details: {
				datumKind: "selected-case",
				datumModule: ids.module,
				slot: "calculate",
				carrier: "field",
			},
		});
		expect(userFacingError(findings[0])).toContain(
			'"Visit" no longer opens with that choice',
		);
		expect(userFacingError(findings[0])).not.toContain(ids.module);
	});
	it("does not mistake a several-case datum for one selected value", () => {
		const doc = formFixture();
		const config = doc.modules[ids.module].caseListConfig;
		if (config === undefined)
			throw new Error("The case list fixture is missing.");
		config.selection = { kind: "multiple", maximum: 10 };
		const parsed = parseFormExpression(
			"instance('commcaresession')/session/data/selected_cases",
			{ doc, slot, lookup: "unavailable" },
		);
		expect(parsed).toMatchObject({
			ok: false,
			issues: [expect.objectContaining({ code: "multi-select-datum-value" })],
		});
	});
	it("locates a link's absent datum and offers values the link can read", () => {
		const doc = formFixture();
		const link = doc.forms[ids.form].formLinks?.[0];
		if (link === undefined) throw new Error("The link fixture is missing.");
		link.condition = {
			kind: "eq",
			left: newCase,
			right: { kind: "term", term: { kind: "literal", value: "case-1" } },
		};
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "SESSION_DATUM_NOT_SUPPLIED",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].details).toMatchObject({
			datumKind: "new-case",
			slot: "form_link_condition",
			carrier: "form-link",
		});
		expect(userFacingError(findings[0])).toContain('A link from "Visit"');
		expect(userFacingError(findings[0])).not.toContain("question");
	});
	it("locates an absent datum in a Connect setting", () => {
		const doc = formFixture();
		doc.connectType = "deliver";
		doc.forms[ids.form].connect = {
			deliver_unit: {
				id: "home_visit",
				name: "Home visit",
				entity_id: newCase,
			},
		};
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "SESSION_DATUM_NOT_SUPPLIED",
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].details).toMatchObject({
			datumKind: "new-case",
			slot: "deliver_entity_id",
			carrier: "connect",
		});
		expect(userFacingError(findings[0])).toContain(
			'A Connect setting of "Visit"',
		);
	});
});
