// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Authored and returned markers remain literal data.
import { describe, expect, it } from "vitest";
import { evaluateForm } from "../evaluateForm";
import { evaluateFormSnapshot } from "../evaluateFormSnapshot";
import { FormEvaluationInputError } from "../formEvaluationTypes";
import { previewAsMe } from "../identity";
import { createEvaluationApp } from "./evaluationFixture";

async function createConstraintApp(mode: "wording" | "rule" | "label") {
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
							kind: "repeat",
							id: "rows",
							label: "Rows",
							repeat: { mode: "user_controlled" },
						},
						{ kind: "text", id: "value", parentUuid: "rows", label: "Value" },
						{
							kind: "int",
							id: "checked",
							label: "Checked",
							default_value: "4",
							validate: {
								expr:
									mode === "rule"
										? "string(#form/rows/value) = 'allowed'"
										: ". < 10",
								msg:
									mode === "wording"
										? "Literal ${0}: {{rows/value}}"
										: "Use an allowed value",
							},
						},
						...(mode === "label"
							? [{ kind: "label", id: "ordinary", label: "{{rows/value}}" }]
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
			cases: { rows: [], indices: [] },
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
		it("continues an invalid retained entry with ambiguous wording, then restores exact wording after row removal", async () => {
			const { doc, formUuid, context } = await createConstraintApp("wording");
			const before = structuredClone(doc);
			const opened = await evaluate(
				doc,
				{
					formUuid,
					repeats: [{ path: "rows", count: 2 }],
					answers: [
						{ path: "rows[0]/value", value: "Data ${0} / ${00}" },
						{ path: "rows[1]/value", value: "Other ${12}" },
					],
				},
				context,
			);
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
			expect(
				invalid.fields
					.filter((field) => field.kind === "text")
					.map(({ path, value }) => ({ path, value })),
			).toEqual([
				{ path: "rows[0]/value", value: "Data ${0} / ${00}" },
				{ path: "rows[1]/value", value: "Other ${12}" },
			]);
			if (!invalid.entry)
				throw new Error("The invalid entry was not captured.");
			const translated = await evaluate(
				doc,
				{ formUuid, language: "spa", answers: [] },
				{ ...context, entry: invalid.entry },
			);
			expect(translated.valid).toBe(false);
			expect(
				translated.fields.find((field) => field.path === "checked"),
			).toMatchObject({
				value: "99",
				error: "Valor no válido",
			});
			if (!translated.entry)
				throw new Error("The translated entry was not captured.");
			const removed = await evaluate(
				doc,
				{
					formUuid,
					language: "spa",
					repeats: [{ path: "rows", count: 1 }],
					answers: [],
				},
				{ ...context, entry: translated.entry },
			);
			expect(removed.valid).toBe(false);
			expect(removed).not.toHaveProperty("submission");
			expect(
				removed.fields.find((field) => field.path === "checked"),
			).toMatchObject({
				value: "99",
				error: "Literal ${0}: Data ${0} / ${00}",
			});
			expect(
				removed.fields.find((field) => field.path === "rows"),
			).toHaveProperty("repeatCount", 1);
			expect(
				removed.fields.find((field) => field.path === "rows[0]/value"),
			).toHaveProperty("value", "Data ${0} / ${00}");
			expect(
				removed.fields.some((field) => field.path === "rows[1]/value"),
			).toBe(false);
			expect(removed.entry?.entryKey).toBe(opened.entry.entryKey);
			expect(doc).toEqual(before);
		});

		it.each(["rule", "label"] as const)(
			"preserves the public fault envelope for an ambiguous ordinary %s",
			async (mode) => {
				const { doc, formUuid, context } = await createConstraintApp(mode);
				const before = structuredClone(doc);
				const result = evaluate(
					doc,
					{ formUuid, repeats: [{ path: "rows", count: 2 }], answers: [] },
					context,
				);
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
