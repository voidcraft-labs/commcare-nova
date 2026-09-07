/**
 * The session-scoped lint context: the same readable case types the deep
 * validator's form-link pass accepts, no form paths, and diagnostics that
 * name WHERE the expression runs when an author reaches for a form answer.
 */

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { blueprintDocSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { buildLintContext } from "../buildLintContext";
import { buildSessionLintContext } from "../buildSessionLintContext";
import { hashtagSource } from "../xpath-autocomplete";
import { xpath } from "../xpath-language";
import {
	caseTypePropsForValidation,
	SESSION_FORM_READ_MESSAGE,
	xpathDiagnostics,
} from "../xpath-lint";

function storeFor(formType: "followup" | "registration") {
	const store = createBlueprintDocStore();
	store.getState().load(
		buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "mood", label: proseText("Mood") },
						{ name: "age", label: proseText("Age") },
					],
				},
			],
			modules: [
				{
					uuid: "mod-care",
					name: "Care",
					caseType: "patient",
					caseListConfig: caseListConfig([{ field: "mood", header: "Mood" }]),
					forms: [
						{
							uuid: "frm-visit",
							name: "Visit",
							type: formType,
							fields: [
								f({
									kind: "text",
									id: "note",
									label: proseText("Note"),
									...(formType === "registration"
										? {
												caseWrite: {
													caseType: "patient",
													property: "case_name",
												},
											}
										: {}),
								}),
							],
						},
					],
				},
			],
		}),
	);
	const state = store.getState();
	blueprintDocSchema.parse(toPersistableDoc(state));
	const verdict = mutationCommitVerdict(state, [], LOOKUP_CONTEXT_UNAVAILABLE);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
	const moduleUuid = state.moduleOrder[0];
	const formUuid = state.formOrder[moduleUuid][0];
	return { state, moduleUuid, formUuid };
}

describe("buildSessionLintContext", () => {
	it("carries no form paths and no form entries, and says so with its scope", () => {
		const { state, formUuid } = storeFor("followup");
		const ctx = buildSessionLintContext(state, formUuid);
		expect(ctx).toBeDefined();
		expect(ctx?.scope).toBe("session");
		expect(ctx?.validPaths.size).toBe(0);
		expect(ctx?.formEntries).toEqual([]);
		expect(ctx?.formType).toBe("followup");
		// The form-scoped twin sees the field; the session one must not.
		const formCtx = buildLintContext(state, formUuid);
		expect(formCtx?.validPaths.has("/data/note")).toBe(true);
	});

	it.each(["followup", "registration"] as const)(
		"%s session offers declared properties; registration field slots remain narrowed",
		(formType) => {
			const { state, formUuid } = storeFor(formType);
			const ctx = buildSessionLintContext(state, formUuid);
			if (!ctx) throw new Error("Missing session context");
			const accept = caseTypePropsForValidation(ctx);
			expect([...(accept?.keys() ?? [])]).toEqual(["patient"]);
			expect([...(accept?.get("patient") ?? [])].sort()).toEqual([
				"age",
				"case_id",
				"mood",
			]);
			const formCtx = buildLintContext(state, formUuid);
			if (!formCtx) throw new Error("Missing form context");
			expect(xpathDiagnostics("#patient/mood = 'good'", ctx)).toEqual([]);
			expect(xpathDiagnostics("#patient/mood = 'good'", formCtx).length).toBe(
				formType === "registration" ? 1 : 0,
			);
		},
	);

	it("returns undefined for a form that no longer exists", () => {
		const { state } = storeFor("followup");
		expect(buildSessionLintContext(state, testUuid("gone"))).toBeUndefined();
	});
});

describe("session-scope diagnostics", () => {
	it("names the closed form for a `/data/` path instead of an unknown field", () => {
		const { state, formUuid } = storeFor("followup");
		const ctx = buildSessionLintContext(state, formUuid);
		const diagnostics = xpathDiagnostics("/data/note = 'yes'", ctx);
		expect(diagnostics.map((d) => d.message)).toEqual([
			SESSION_FORM_READ_MESSAGE,
		]);
		expect(diagnostics[0]).toMatchObject({ from: 0, to: "/data/note".length });
	});

	it("names the closed form for a `#form/` reference", () => {
		const { state, formUuid } = storeFor("followup");
		const ctx = buildSessionLintContext(state, formUuid);
		const diagnostics = xpathDiagnostics("#form/note = 'yes'", ctx);
		expect(diagnostics.map((d) => d.message)).toEqual([
			SESSION_FORM_READ_MESSAGE,
		]);
		expect(diagnostics[0]).toMatchObject({ from: 0, to: "#form/note".length });
	});

	it("accepts a readable case property without complaint", () => {
		const { state, formUuid } = storeFor("followup");
		const ctx = buildSessionLintContext(state, formUuid);
		expect(xpathDiagnostics("#patient/mood = 'good'", ctx)).toEqual([]);
	});

	it("accepts the new case's properties on a registration form's links", () => {
		const { state, formUuid } = storeFor("registration");
		const ctx = buildSessionLintContext(state, formUuid);
		expect(xpathDiagnostics("#patient/mood = 'good'", ctx)).toEqual([]);
	});

	it("refuses a bare relative name, which has no context node after the form closes", () => {
		const { state, formUuid } = storeFor("followup");
		const ctx = buildSessionLintContext(state, formUuid);
		const diagnostics = xpathDiagnostics("mood = 'good'", ctx);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain("after the form has closed");
		expect(diagnostics[0]).toMatchObject({ from: 0, to: "mood".length });
	});

	it("reports a `#form/` read once, not once as a hashtag and once as its path", () => {
		const { state, formUuid } = storeFor("followup");
		const ctx = buildSessionLintContext(state, formUuid);
		const diagnostics = xpathDiagnostics(
			"#form/note = 'yes' and /data/other = 1",
			ctx,
		);
		expect(diagnostics.map((d) => [d.from, d.to, d.message])).toEqual([
			[0, "#form/note".length, SESSION_FORM_READ_MESSAGE],
			[
				"#form/note = 'yes' and ".length,
				"#form/note = 'yes' and /data/other".length,
				SESSION_FORM_READ_MESSAGE,
			],
		]);
	});

	it("keeps the form-scope wording for a field slot", () => {
		const { state, formUuid } = storeFor("followup");
		const ctx = buildLintContext(state, formUuid);
		const diagnostics = xpathDiagnostics("/data/missing = 'yes'", ctx);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).not.toBe(SESSION_FORM_READ_MESSAGE);
		expect(xpathDiagnostics("#form/note = 'yes'", ctx)).toEqual([]);
	});
});

describe("session-scope autocomplete", () => {
	function completionsFor(doc: string, formType: "followup") {
		const { state, formUuid } = storeFor(formType);
		const ctx = buildSessionLintContext(state, formUuid);
		const editorState = EditorState.create({ doc, extensions: [xpath()] });
		return hashtagSource(() => ctx)(
			new CompletionContext(editorState, doc.length, false),
		);
	}

	it("withholds the #form/ namespace", () => {
		const result = completionsFor("#", "followup");
		const labels = result?.options.map((option) => option.label) ?? [];
		expect(labels).not.toContain("#form/");
		expect(labels).toContain("#user/");
		expect(labels).toContain("#patient/");
	});

	it("offers nothing under #form/", () => {
		expect(completionsFor("#form/", "followup")).toBeNull();
	});
});
