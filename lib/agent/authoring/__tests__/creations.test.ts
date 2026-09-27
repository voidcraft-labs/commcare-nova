import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import { addFieldsTool } from "@/lib/agent/tools/addFields";
import { prepareAuthoringInput } from "../input";

it("rejects cyclic new parents without changing the app", async () => {
	const { workspace } = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
	const before = workspace.currentSnapshot().doc;
	const formUuid = Object.keys(before.forms)[0];
	const first = testUuid("cyclic-first");
	const second = testUuid("cyclic-second");
	await expect(
		workspace.invoke({
			toolName: "addFields",
			execute: async (ctx) => {
				const canonical = await prepareAuthoringInput({
					toolName: "addFields",
					schema: addFieldsTool.inputSchema,
					ctx,
					input: {
						formUuid,
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
				});
				return addFieldsTool.execute(canonical, ctx);
			},
		}),
	).rejects.toThrow("cyclic parents");
	expect(workspace.currentSnapshot().doc).toEqual(before);
});

it("adds questions atomically with forward parent names and answer references, preserving sibling order", async () => {
	const { workspace } = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
	const before = workspace.currentSnapshot().doc;
	const formUuid = Object.keys(before.forms)[0];
	const input = {
		formUuid,
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
	};
	const result = await workspace.invoke({
		toolName: "addFields",
		async execute(ctx) {
			const canonical = await prepareAuthoringInput({
				toolName: "addFields",
				schema: addFieldsTool.inputSchema,
				input,
				ctx,
			});
			return addFieldsTool.execute(canonical, ctx);
		},
	});
	expect(result).toMatchObject({ kind: "mutate", result: { ok: true } });
	const doc = workspace.currentSnapshot().doc;
	const group = Object.values(doc.fields).find(
		(field) => field.id === "demographics",
	);
	const age = Object.values(doc.fields).find((field) => field.id === "age");
	const summary = Object.values(doc.fields).find(
		(field) => field.id === "summary",
	);
	if (!group || !age || !summary || summary.kind !== "label")
		throw new Error("The questions were not created.");
	expect(doc.fieldParent[age.uuid]).toBe(group.uuid);
	expect(summary.label).toEqual({
		parts: [
			{ kind: "text", text: "Age: " },
			{ kind: "field-ref", uuid: age.uuid },
		],
	});
	expect(doc.fieldOrder[formUuid]).toEqual([
		...before.fieldOrder[formUuid],
		summary.uuid,
		group.uuid,
	]);
});
