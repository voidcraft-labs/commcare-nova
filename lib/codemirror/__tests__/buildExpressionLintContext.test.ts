import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { prepareFormConnectExpressions } from "@/lib/doc/formExpressionStructure";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { buildExpressionLintContext } from "../buildLintContext";
import { hashtagSource } from "../xpath-autocomplete";
import { xpath } from "../xpath-language";
import { xpathDiagnostics } from "../xpath-lint";

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
						fields: [{ uuid: FIELD, id: "note", kind: "text" }],
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

describe("actual-slot expression lint context", () => {
	it("builds context for an empty optional field expression and parses against its owner", () => {
		const ctx = buildExpressionLintContext(
			fixture(),
			{ entity: "field", uuid: FIELD, slot: "relevant" },
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(ctx?.expressionContext.slot).toEqual({
			entity: "field",
			uuid: FIELD,
			slot: "relevant",
		});
		expect(xpathDiagnostics("#form/note = 'yes'", ctx)).toEqual([]);
	});

	it("withholds form completions and refuses form reads in a real after-submit member", () => {
		const ctx = buildExpressionLintContext(
			fixture(),
			{
				entity: "form",
				uuid: FORM,
				slot: "form_link_condition",
				member: { linkUuid: LINK },
			},
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(ctx?.scope).toBe("session");
		expect(ctx?.validPaths.size).toBe(0);
		expect(ctx?.formEntries).toEqual([]);
		expect(xpathDiagnostics("#patient/age > 18", ctx)).toEqual([]);
		expect(xpathDiagnostics("#form/note = 'yes'", ctx).length).toBeGreaterThan(
			0,
		);
		const state = EditorState.create({ doc: "#", extensions: [xpath()] });
		const completions = hashtagSource(() => ctx)(
			new CompletionContext(state, 1, true),
		);
		expect(completions?.options.map(({ label }) => label)).not.toContain(
			"#form/",
		);
	});

	it("returns no context when the owner or nested member was deleted", () => {
		const doc = fixture();
		expect(
			buildExpressionLintContext(
				doc,
				{ entity: "field", uuid: testUuid("gone"), slot: "relevant" },
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toBeUndefined();
		expect(
			buildExpressionLintContext(
				doc,
				{
					entity: "form",
					uuid: FORM,
					slot: "form_link_condition",
					member: { linkUuid: testUuid("gone") },
				},
				LOOKUP_CONTEXT_UNAVAILABLE,
			),
		).toBeUndefined();
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
		const ctx = buildExpressionLintContext(
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
