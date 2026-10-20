/**
 * The linter over real slots: `xpathDiagnostics` returns the slot editor
 * context's own check, built from the slot's profile. The plausible
 * failures: an after-submit slot linted as if the form were still open
 * (offering or admitting a form read), a finding placed anywhere but its
 * own span when the text is spaced unlike the print, and a slot whose
 * owner is gone still accepting a save.
 */

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { SESSION_FORM_READ_MESSAGE } from "@/lib/commcare/validator/formLogicFindings";
import { prepareFormConnectExpressions } from "@/lib/doc/formExpressionStructure";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import { buildExpressionEditorContext } from "../expressionEditorContext";
import { hashtagSource } from "../xpath-autocomplete";
import { xpath } from "../xpath-language";
import {
	EXPRESSION_CONTEXT_UNAVAILABLE_MESSAGE,
	xpathDiagnostics,
} from "../xpath-lint";

const MODULE = testUuid("lint-module");
const FORM = testUuid("lint-form");
const FIELD = testUuid("lint-field");
const LINK = testUuid("lint-link");

function fixture() {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "age", label: "Age", data_type: "int" }],
			},
		],
		modules: [
			{
				uuid: MODULE,
				name: "Care",
				caseType: "patient",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							{ uuid: FIELD, id: "note", kind: "text" },
							{ id: "count", kind: "int" },
						],
					},
				],
			},
		],
	});
	doc.forms[FORM].formLinks = [
		{
			uuid: LINK,
			target: { type: "form", moduleUuid: MODULE, formUuid: FORM },
		},
	];
	return doc;
}

const FIELD_SLOT: ExpressionSlotRef = {
	entity: "field",
	uuid: FIELD,
	slot: "relevant",
};
const LINK_SLOT: ExpressionSlotRef = {
	entity: "form",
	uuid: FORM,
	slot: "form_link_condition",
	member: { linkUuid: LINK },
};

function context(slot: ExpressionSlotRef, doc = fixture()) {
	return buildExpressionEditorContext(doc, slot, LOOKUP_CONTEXT_UNAVAILABLE);
}

describe("a question's slot", () => {
	it("builds context for an empty optional slot and checks against its owner", () => {
		const ctx = context(FIELD_SLOT);
		expect(ctx?.slot).toEqual(FIELD_SLOT);
		expect(ctx?.scope.slot).toEqual(FIELD_SLOT);
		expect(ctx?.reference.scope).toBe("form");
		expect(xpathDiagnostics("#form/note = 'yes'", ctx)).toEqual([]);
		expect(xpathDiagnostics("../note = 'yes'", ctx)).toEqual([]);
	});

	it("underlines a parse issue and a checker finding at their own spans, however the text is spaced", () => {
		const ctx = context(FIELD_SLOT);
		const unknown = "../note   =   'yes' and ../missing = 1";
		const [issue] = xpathDiagnostics(unknown, ctx);
		expect(unknown.slice(issue.from, issue.to)).toBe("missing");
		const typed = "../note  =  'yes'  and  #form/count  +  'x'  >  1";
		const findings = xpathDiagnostics(typed, ctx);
		expect(findings.length).toBeGreaterThan(0);
		for (const finding of findings) {
			expect(finding.from).toBeGreaterThan(typed.indexOf("and"));
			expect(finding.to).toBeLessThanOrEqual(typed.length);
		}
	});
});

describe("an after-submit slot: its profile is the session scope", () => {
	it("admits a readable case property", () => {
		const ctx = context(LINK_SLOT);
		expect(ctx?.reference.scope).toBe("session");
		expect(xpathDiagnostics("#patient/age > 18", ctx)).toEqual([]);
	});

	it("refuses a form read with the sentence that says the form has closed", () => {
		const ctx = context(LINK_SLOT);
		expect(
			xpathDiagnostics("#form/note = 'yes'", ctx).map(
				(diagnostic) => diagnostic.message,
			),
		).toContain(SESSION_FORM_READ_MESSAGE);
	});

	it("refuses a bare relative name with the sentence that says there is no current question", () => {
		const ctx = context(LINK_SLOT);
		expect(
			xpathDiagnostics("../note = 'yes'", ctx).map(
				(diagnostic) => diagnostic.message,
			),
		).toEqual([
			"This expression has no current question. You can read a record property or a session value instead.",
		]);
	});

	it("withholds form paths and the #form/ namespace from completion", () => {
		const ctx = context(LINK_SLOT);
		expect(ctx?.reference.validPaths.size).toBe(0);
		expect(ctx?.reference.formEntries).toEqual([]);
		expect(ctx?.reads.relative).toBeUndefined();
		const state = EditorState.create({ doc: "#", extensions: [xpath()] });
		const completions = hashtagSource(() => ctx?.reference)(
			new CompletionContext(state, 1, true),
		);
		expect(completions?.options.map(({ label }) => label)).not.toContain(
			"#form/",
		);
	});
});

describe("a slot whose place changed", () => {
	it("has no context when the owner or nested member was deleted, and refuses the text", () => {
		const doc = fixture();
		expect(
			buildExpressionEditorContext(
				doc,
				{ entity: "field", uuid: testUuid("gone"), slot: "relevant" },
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toBeUndefined();
		expect(
			context(
				{
					entity: "form",
					uuid: FORM,
					slot: "form_link_condition",
					member: { linkUuid: testUuid("gone") },
				},
				doc,
			),
		).toBeUndefined();
		expect(xpathDiagnostics("1 = 1", undefined).map((d) => d.message)).toEqual([
			EXPRESSION_CONTEXT_UNAVAILABLE_MESSAGE,
		]);
	});

	it("uses pending Connect blocks while the saved app is still disabled", () => {
		const doc = fixture();
		const form = prepareFormConnectExpressions(
			doc,
			FORM,
			"learn",
			{ assessment: { id: "quiz" } },
			new Map(),
			"unavailable",
		);
		const ctx = buildExpressionEditorContext(
			doc,
			{ entity: "form", uuid: FORM, slot: "assessment_user_score" },
			LOOKUP_CONTEXT_UNAVAILABLE,
			{ form },
		);
		expect(ctx).toBeDefined();
		expect(xpathDiagnostics("1 + 2", ctx)).toEqual([]);
		expect(doc.connectType).toBeNull();
		expect(doc.forms[FORM].connect).toBeUndefined();
	});
});
