// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Authored and returned markers remain literal data.
import { describe, expect, it } from "vitest";
import { USERCASE_CASE_TYPE } from "@/lib/domain";
import type { CaseRow } from "../caseDataBindingTypes";
import { evaluateForm } from "../evaluateForm";
import { evaluateFormSnapshot } from "../evaluateFormSnapshot";
import { FormEvaluationInputError } from "../formEvaluationTypes";
import { previewAsMe } from "../identity";
import { createEvaluationApp } from "./evaluationFixture";

/** The worker's record is a case-database read, so only the device's data
 * decides how many records answer it: the app is admitted, and several
 * matching records meet Core's one-node unpack at run time. */
function workerRecords(usernames: readonly string[]): CaseRow[] {
	return usernames.map((username, index) => ({
		case_id: `worker-record-${index}`,
		app_id: "app-1",
		case_type: USERCASE_CASE_TYPE,
		owner_id: "member",
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		case_name: `Worker record ${index}`,
		external_id: null,
		parent_case_id: null,
		properties: { hq_user_id: "member", username },
	}));
}

async function createConstraintApp(
	mode: "wording" | "rule" | "label",
	usernames: readonly string[],
) {
	const doc = await createEvaluationApp(
		[{ name: "Work", forms: [{ name: "Check", type: "survey" }] }],
		[
			{
				toolName: "addFields",
				input: {
					moduleUuid: "Work",
					formUuid: "Check",
					fields: [
						{
							kind: "int",
							id: "checked",
							label: "Checked",
							default_value: "4",
							validate: {
								expr:
									mode === "rule"
										? "string(#user/username) = 'allowed'"
										: ". < 10",
								msg:
									mode === "wording"
										? "Literal ${0}: {{#user/username}}"
										: "Use an allowed value",
							},
						},
						...(mode === "label"
							? [
									{
										kind: "label",
										id: "ordinary",
										label: "{{#user/username}}",
									},
								]
							: []),
					],
				},
			},
			{
				toolName: "removeField",
				input: {
					moduleUuid: "Work",
					formUuid: "Check",
					fieldUuid: "fixture_placeholder",
				},
			},
			{ toolName: "addLanguage", input: { language: { language: "spa" } } },
		],
	);
	const formUuid = Object.values(doc.forms).find(
		(form) => form.name === "Check",
	)?.uuid;
	const identity = previewAsMe({ id: "member" }, doc);
	if (!formUuid || !identity)
		throw new Error("Evaluation fixture is incomplete.");
	return {
		doc,
		formUuid,
		context: {
			captureEntry: true,
			identity,
			cases: { rows: workerRecords(usernames), indices: [] },
			lookup: {
				projectRevision: "0",
				definitions: [],
				rowsByTable: new Map(),
			},
		},
	};
}

for (const [boundary, evaluate] of [
	["snapshot with the production XPath dispatcher", evaluateFormSnapshot],
	["isolated Node worker", evaluateForm],
] as const) {
	describe(boundary, () => {
		it("continues an invalid retained entry with ambiguous wording in each language, beside one record's exact wording", async () => {
			const exact = await createConstraintApp("wording", ["Data ${0} / ${00}"]);
			const single = await evaluate(
				exact.doc,
				{
					formUuid: exact.formUuid,
					answers: [{ path: "checked", value: "99" }],
				},
				exact.context,
			);
			expect(
				single.fields.find((field) => field.path === "checked"),
			).toMatchObject({
				value: "99",
				valid: false,
				error: "Literal ${0}: Data ${0} / ${00}",
			});

			const { doc, formUuid, context } = await createConstraintApp("wording", [
				"Data ${0} / ${00}",
				"Other ${12}",
			]);
			const before = structuredClone(doc);
			const opened = await evaluate(doc, { formUuid, answers: [] }, context);
			expect(opened.valid).toBe(true);
			if (!opened.entry) throw new Error("The opened entry was not captured.");
			const invalid = await evaluate(
				doc,
				{ formUuid, answers: [{ path: "checked", value: "99" }] },
				{ ...context, entry: opened.entry },
			);
			expect(invalid.valid).toBe(false);
			expect(invalid).not.toHaveProperty("submission");
			expect(
				invalid.fields.find((field) => field.path === "checked"),
			).toMatchObject({
				value: "99",
				valid: false,
				error: "Invalid value",
			});
			if (!invalid.entry)
				throw new Error("The invalid entry was not captured.");
			const translated = await evaluate(
				doc,
				{ formUuid, language: "spa", answers: [] },
				{ ...context, entry: invalid.entry },
			);
			expect(translated.valid).toBe(false);
			expect(translated).not.toHaveProperty("submission");
			expect(
				translated.fields.find((field) => field.path === "checked"),
			).toMatchObject({
				value: "99",
				error: "Valor no válido",
			});
			expect(translated.entry?.entryKey).toBe(opened.entry.entryKey);
			expect(doc).toEqual(before);
		});

		it.each(["rule", "label"] as const)(
			"preserves the public fault envelope for an ambiguous ordinary %s",
			async (mode) => {
				const one = await createConstraintApp(mode, ["allowed"]);
				expect(
					(
						await evaluate(
							one.doc,
							{ formUuid: one.formUuid, answers: [] },
							one.context,
						)
					).valid,
				).toBe(true);
				const { doc, formUuid, context } = await createConstraintApp(mode, [
					"allowed",
					"other",
				]);
				const before = structuredClone(doc);
				const result = evaluate(doc, { formUuid, answers: [] }, context);
				await expect(result).rejects.toBeInstanceOf(FormEvaluationInputError);
				await expect(result).rejects.toMatchObject({
					message: "An expression could not be evaluated.",
					fault: {
						path: mode === "rule" ? "/data/checked" : "/data/ordinary",
						code: "evaluation-failed",
						reason: { phase: "evaluation", kind: "nodeset-cardinality" },
					},
				});
				expect(doc).toEqual(before);
			},
		);
	});
}
