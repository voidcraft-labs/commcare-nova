import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { createModuleTool } from "@/lib/agent/tools/createModule";
import { prepareAuthoringInput } from "../input";

it("rejects cyclic new parents without changing the app", async () => {
	const { workspace } = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
	const before = workspace.currentSnapshot().doc;
	const first = testUuid("cyclic-first");
	const second = testUuid("cyclic-second");
	await expect(
		workspace.invoke({
			toolName: "createModule",
			execute: async (ctx) => {
				const canonical = await prepareAuthoringInput({
					toolName: "createModule",
					schema: createModuleTool.inputSchema,
					ctx,
					input: {
						name: "Visits",
						forms: [
							{
								name: "Survey",
								type: "survey",
								fields: [
									{
										fieldUuid: first,
										kind: "group",
										id: "first",
										label: "First",
										parentUuid: second,
									},
									{
										fieldUuid: second,
										kind: "group",
										id: "second",
										label: "Second",
										parentUuid: first,
									},
								],
							},
						],
					},
				});
				return createModuleTool.execute(canonical, ctx);
			},
		}),
	).rejects.toThrow("cyclic parents");
	expect(workspace.currentSnapshot().doc).toEqual(before);
});

it("creates a form atomically with forward parent names and answer references, preserving sibling order", async () => {
	const { workspace } = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
	const input: Record<string, unknown> = {
		name: "Visits",
		forms: [
			{
				name: "Check-in",
				type: "survey",
				fields: [
					{
						kind: "int",
						id: "age",
						label: "Age",
						required: true,
						parentUuid: "demographics",
					},
					{ kind: "label", id: "summary", label: "Age: {{demographics/age}}" },
					{ kind: "group", id: "demographics", label: "Details" },
				],
			},
		],
	};
	const result = await workspace.invoke({
		toolName: "createModule",
		async execute(ctx) {
			const canonical = await prepareAuthoringInput({
				toolName: "createModule",
				schema: createModuleTool.inputSchema,
				input,
				ctx,
			});
			return createModuleTool.execute(canonical, ctx);
		},
	});
	expect(result).toMatchObject({
		kind: "mutate",
		result: { moduleUuid: expect.any(String) },
	});
	const doc = workspace.currentSnapshot().doc;
	const group = Object.values(doc.fields).find(
		(field) => field.id === "demographics",
	);
	const age = Object.values(doc.fields).find((field) => field.id === "age");
	const summary = Object.values(doc.fields).find(
		(field) => field.id === "summary",
	);
	if (!group || !age || !summary || summary.kind !== "label")
		throw new Error("The atomic form was not created.");
	expect(doc.fieldParent[age.uuid]).toBe(group.uuid);
	expect(summary.label).toEqual({
		parts: [
			{ kind: "text", text: "Age: " },
			{ kind: "field-ref", uuid: age.uuid },
		],
	});
	const form = Object.values(doc.forms).find(
		(form) => form.name === "Check-in",
	);
	if (!form) throw new Error("The form was not created.");
	expect(doc.fieldOrder[form.uuid]).toEqual([summary.uuid, group.uuid]);
});
