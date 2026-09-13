import { describe, expect, it, vi } from "vitest";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { parseAuthoredXPath } from "@/lib/doc/expressionText";
import { asUuid, fieldPathResolver, proseTemplateSchema } from "@/lib/domain";
import { deduplicatePilotCalls } from "../comparison";
import { executePilotOperation, nativePilotTools } from "../native";
import { normalizeText, printAuthoringText } from "../values";

const clientMenu = {
	name: "Clients",
	case_type: "client",
	case_list_columns: [{ kind: "plain", field: "case_name", header: "Name" }],
	forms: [
		{
			name: "Register a client",
			type: "registration",
			fields: [
				{
					kind: "text",
					id: "client_name",
					caseWrite: { caseType: "client", property: "case_name" },
					required: true,
				},
				{
					kind: "int",
					id: "age",
					label: "Age in years",
					validate: {
						expr: "#form/age >= 0",
						msg: "Age cannot be negative.",
					},
				},
				{
					kind: "label",
					id: "advice",
					label: "Advice for {{client_name}}. Ask about #form/history.",
					relevant: "#form/age >= 18",
				},
			],
		},
	],
};

async function declareClients(
	workspace: ReturnType<typeof makeToolWorkspaceHarness>["workspace"],
) {
	expect(
		await executePilotOperation(workspace, "declareRecords", {
			caseTypes: [
				{
					name: "client",
					properties: [
						{ name: "case_name", label: "Client name", data_type: "text" },
					],
				},
			],
		}),
	).toMatchObject({ status: "committed" });
}

describe("native authoring comparison", () => {
	it("reuses one accepted creation across repeated concurrent delivery", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		await declareClients(harness.workspace);
		harness.recordMutations.mockClear();
		const definition = deduplicatePilotCalls(
			nativePilotTools(harness.workspace),
		).createModule;
		if (!definition) throw new Error("Missing function tool.");
		const execute = definition.execute;
		if (!execute) throw new Error("Missing creation tool.");
		const options = { toolCallId: "same-call", messages: [] };
		const [first, repeated] = await Promise.all([
			execute(clientMenu, options),
			execute(clientMenu, options),
		]);
		expect(first).toMatchObject({ status: "committed" });
		expect(repeated).toEqual(first);
		expect(harness.recordMutations).toHaveBeenCalledTimes(1);
		expect(() =>
			execute({ ...clientMenu, name: "A different menu" }, options),
		).toThrow("changed its input");
	});

	it("preserves literal template text and real references through read and edit", () => {
		const doc = makeCanonicalGenesisDoc();
		const formUuid = Object.values(doc.forms)[0]?.uuid;
		const field = Object.values(doc.fields)[0];
		if (!formUuid || !field) throw new Error("Missing starter field.");
		const template = proseTemplateSchema.parse({
			parts: [
				{
					kind: "text",
					text: "  Literal {{answer}}, \\{{answer}} and #form/answer. Hello \\",
				},
				{ kind: "field-ref", uuid: field.uuid },
				{ kind: "text", text: "!\n" },
			],
		});
		const source = printAuthoringText(template, doc);
		expect(
			normalizeText(source, (source) =>
				parseAuthoredXPath(
					doc,
					formUuid,
					fieldPathResolver(doc, formUuid),
					source,
				),
			),
		).toEqual(template);
	});

	it("lets the workspace reload an authoritative conflict before surfacing it", async () => {
		const freshDoc = makeCanonicalGenesisDoc("A peer's change");
		const reload = vi.fn(async () => ({ doc: freshDoc, canonicalSeq: 42 }));
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc(), {
			reloadAuthorizedSnapshot: reload,
		});
		harness.recordMutations.mockRejectedValueOnce(
			new BlueprintCommitRejectedError("A peer changed the app."),
		);
		await expect(
			executePilotOperation(harness.workspace, "declareRecords", {
				caseTypes: [
					{
						name: "client",
						properties: [{ name: "case_name", label: "Name" }],
					},
				],
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(reload).toHaveBeenCalledOnce();
		expect(harness.currentDoc()).toBe(freshDoc);
	});
	it("creates a complete workflow and preserves typed references through a dependent rename and repair", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		await declareClients(harness.workspace);
		const result = await executePilotOperation(
			harness.workspace,
			"createModule",
			clientMenu,
		);
		expect(result, JSON.stringify(result)).toMatchObject({
			status: "committed",
		});
		const refs: Record<string, string> = {};
		for (const [key, id] of [
			["@name", "client_name"],
			["@age", "age"],
			["@advice", "advice"],
		]) {
			const field = Object.values(harness.currentDoc().fields).find(
				(field) => field.id === id,
			);
			if (!key || !field) throw new Error("Missing created field.");
			refs[key] = field.uuid;
		}
		const beforeEdit = harness.currentDoc();
		expect(beforeEdit.fields[asUuid(refs["@name"] ?? "")]).toMatchObject({
			required: { parts: [{ kind: "text", text: "true()" }] },
			label: { parts: [{ kind: "text", text: "Client name" }] },
		});
		expect(beforeEdit.fields[asUuid(refs["@advice"] ?? "")]).toMatchObject({
			label: {
				parts: [
					{ kind: "text", text: "Advice for " },
					{ kind: "field-ref", uuid: refs["@name"] },
					{ kind: "text", text: ". Ask about #form/history." },
				],
			},
		});
		expect(
			await executePilotOperation(harness.workspace, "editField", {
				fieldUuid: refs["@age"],
				updates: {
					id: "age_years",
					hint: "Use completed years.",
					validate: {
						expr: "#form/age_years >= 0 and #form/age <= 120",
						msg: "Age must be from 0 to 120.",
					},
				},
			}),
		).toMatchObject({ status: "committed" });
		expect(
			harness.currentDoc().fields[asUuid(refs["@advice"] ?? "")],
		).toMatchObject({
			relevant: {
				parts: [
					{ kind: "field-ref", uuid: refs["@age"] },
					{ kind: "text", text: " >= 18" },
				],
			},
		});
		const beforeRejection = harness.currentDoc();
		expect(
			await executePilotOperation(harness.workspace, "editField", {
				fieldUuid: refs["@age"],
				updates: { id: "client_name" },
			}),
		).toMatchObject({ status: "rejected", error: expect.any(String) });
		expect(harness.currentDoc()).toBe(beforeRejection);
		expect(
			await executePilotOperation(harness.workspace, "editField", {
				fieldUuid: refs["@age"],
				updates: { label: "Age", hint: null },
			}),
		).toMatchObject({ status: "committed" });
		const finalField = harness.currentDoc().fields[asUuid(refs["@age"] ?? "")];
		expect(finalField).toMatchObject({
			id: "age_years",
			kind: "int",
			label: { parts: [{ kind: "text", text: "Age" }] },
		});
		expect(finalField).not.toHaveProperty("hint");
		expect(finalField).toHaveProperty("validate");
		expect(
			await executePilotOperation(harness.workspace, "inspect", {
				uuid: refs["@age"],
			}),
		).toMatchObject({
			field: {
				validate: {
					expr: "#form/age_years >= 0 and #form/age_years <= 120",
					msg: "Age must be from 0 to 120.",
				},
			},
		});
	});

	it("binds a closure question and preserves choice identities when labels change", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		await declareClients(harness.workspace);
		const created = await executePilotOperation(
			harness.workspace,
			"createModule",
			{
				...clientMenu,
				forms: [
					...clientMenu.forms,
					{
						name: "Review client",
						type: "close",
						close_condition: { field: "close_client", answer: "yes" },
						fields: [
							{
								kind: "single_select",
								id: "close_client",
								label: "Close this client's record?",
								relevant: "#case/case_name != ''",
								optionsSource: {
									kind: "inline",
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								},
							},
						],
					},
				],
			},
		);
		expect(created, JSON.stringify(created)).toMatchObject({
			status: "committed",
		});
		const field = Object.values(harness.currentDoc().fields).find(
			(field) => field.id === "close_client",
		);
		const form = Object.values(harness.currentDoc().forms).find(
			(form) => form.name === "Review client",
		);
		if (
			field?.kind !== "single_select" ||
			field.optionsSource.kind !== "inline"
		)
			throw new Error("Missing close question.");
		expect(form?.closeCondition).toMatchObject({
			field: field.uuid,
			answer: "yes",
		});
		expect(field.relevant).toEqual({
			parts: [
				{ kind: "case-ref", caseType: "client", property: "case_name" },
				{ kind: "text", text: " != ''" },
			],
		});
		const read = (await executePilotOperation(harness.workspace, "inspect", {
			uuid: field.uuid,
		})) as {
			field: {
				optionsSource: {
					kind: "inline";
					options: { value: string; label: string }[];
				};
			};
		};
		const choices = read.field.optionsSource;
		if (!choices.options[0] || !choices.options[1])
			throw new Error("Missing choices.");
		choices.options[0].label = "Close record";
		choices.options[1].label = "Keep open";
		expect(
			await executePilotOperation(harness.workspace, "editField", {
				fieldUuid: field.uuid,
				updates: {
					optionsSource: choices,
				},
			}),
		).toMatchObject({ status: "committed" });
		expect(harness.currentDoc().fields[field.uuid]).toMatchObject({
			optionsSource: {
				options: [
					{
						uuid: field.optionsSource.options[0]?.uuid,
						label: { parts: [{ kind: "text", text: "Close record" }] },
					},
					{
						uuid: field.optionsSource.options[1]?.uuid,
						label: { parts: [{ kind: "text", text: "Keep open" }] },
					},
				],
			},
		});
		if (!form) throw new Error("Missing closure form.");
		const readForm = (await executePilotOperation(
			harness.workspace,
			"inspect",
			{ uuid: form.uuid },
		)) as { form: { close_condition: unknown } };
		expect(
			await executePilotOperation(harness.workspace, "updateForm", {
				formUuid: form.uuid,
				name: "Close client",
				close_condition: readForm.form.close_condition,
			}),
		).toMatchObject({ status: "committed" });
		expect(harness.currentDoc().forms[form.uuid]).toMatchObject({
			name: "Close client",
			closeCondition: form.closeCondition,
		});
	});

	it("rejects unknown references before any write", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		await declareClients(harness.workspace);
		const before = harness.currentDoc();
		harness.recordMutations.mockClear();
		for (const badReference of [
			"#form/register",
			"#form/missing",
			"age",
			"../age",
		]) {
			const input = structuredClone(clientMenu);
			const advice = input.forms[0]?.fields[2];
			if (!advice) throw new Error("Missing advice fixture.");
			advice.relevant = `${badReference} >= 18`;
			expect(
				await executePilotOperation(harness.workspace, "createModule", input),
			).toMatchObject({
				status: "rejected",
				error: expect.stringContaining("reference"),
			});
			expect(harness.currentDoc()).toBe(before);
		}
		expect(harness.recordMutations).not.toHaveBeenCalled();
	});

	it("rejects the complete module when one field violates canonical validity", async () => {
		const harness = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		await declareClients(harness.workspace);
		const input = structuredClone(clientMenu);
		if (input.forms[0]?.fields[0])
			input.forms[0].fields[0].id = "bad identifier";
		const before = harness.currentDoc();
		expect(
			await executePilotOperation(harness.workspace, "createModule", input),
		).toMatchObject({ status: "rejected" });
		expect(harness.currentDoc()).toBe(before);
	});
});
