import { expect, it } from "vitest";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { createFormInputSchema } from "@/lib/agent/tools/createForm";
import { createModuleInputSchema } from "@/lib/agent/tools/createModule";
import { editFieldInputSchema } from "@/lib/agent/tools/editField";
import { moveModuleInputSchema } from "@/lib/agent/tools/moveModule";
import { authoringToolSchema } from "../toolSchema";

it("registers one authored grammar for every shared tool", () => {
	for (const entry of SHARED_TOOL_REGISTRY) {
		const grammar = authoringToolSchema(entry.saName, entry.tool.inputSchema);
		expect(JSON.stringify(grammar.json), entry.saName).not.toContain(
			'"parts":',
		);
	}
});

it("lets authors name targets and containers without allocating identities or repeating known parents and kinds", () => {
	const create = authoringToolSchema(
		"createModule",
		createModuleInputSchema,
	).authored;
	expect(
		create.safeParse({
			name: "Visits",
			forms: [
				{
					name: "Survey",
					type: "survey",
					fields: [
						{ kind: "group", id: "details", label: "Details" },
						{ kind: "text", id: "name", parentUuid: "details", label: "Name" },
					],
				},
			],
		}).success,
	).toBe(true);
	expect(
		create.safeParse({ moduleUuid: "Visits", name: "Visits" }).success,
	).toBe(false);
	const createForm = authoringToolSchema(
		"createForm",
		createFormInputSchema,
	).authored;
	const fields = [{ kind: "text", id: "name", label: "Name" }];
	expect(
		createForm.safeParse({ name: "Survey", type: "survey", fields }).success,
	).toBe(false);
	expect(
		createForm.safeParse({
			moduleUuid: "Visits",
			name: "Survey",
			type: "survey",
			fields,
		}).success,
	).toBe(true);
	const edit = authoringToolSchema("editField", editFieldInputSchema).authored;
	expect(
		edit.safeParse({
			fieldUuid: "details/name",
			formUuid: "Survey",
			updates: { label: "Full name" },
		}).success,
	).toBe(true);
	expect(
		edit.safeParse({
			fieldUuid: "details/name",
			updates: { label: { parts: [{ kind: "text", text: "Full name" }] } },
		}).success,
	).toBe(false);
	const move = authoringToolSchema(
		"moveModule",
		moveModuleInputSchema,
	).authored;
	expect(
		move.safeParse({
			moduleUuid: "Visits",
			parentModuleUuid: null,
			after: null,
		}).success,
	).toBe(true);
});
