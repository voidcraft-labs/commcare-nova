import { expect, it } from "vitest";
import { addModuleMutations } from "@/lib/agent/blueprintHelpers";
import { createFormInputSchema } from "@/lib/agent/tools/createForm";
import { createModuleInputSchema } from "@/lib/agent/tools/createModule";
import { editFieldInputSchema } from "@/lib/agent/tools/editField";
import { moveModuleInputSchema } from "@/lib/agent/tools/moveModule";
import { asUuid } from "@/lib/domain";
import { authoringToolSchema } from "../toolSchema";

it("lets authors name targets and containers without allocating identities or repeating known parents and kinds", () => {
	const create = authoringToolSchema(
		"createModule",
		createModuleInputSchema,
	).authored;
	expect(create.safeParse({ name: "Visits" }).success).toBe(true);
	expect(
		create.safeParse({ moduleUuid: "Visits", name: "Visits" }).success,
	).toBe(false);
	const createForm = authoringToolSchema(
		"createForm",
		createFormInputSchema,
	).authored;

	expect(createForm.safeParse({ name: "Survey", type: "survey" }).success).toBe(
		false,
	);
	expect(
		createForm.safeParse({
			moduleUuid: "Visits",
			name: "Survey",
			type: "survey",
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

it("rejects composite creation inputs instead of silently discarding their requested content", () => {
	const module = authoringToolSchema(
		"createModule",
		createModuleInputSchema,
	).authored;
	for (const extra of [
		{ forms: [] },
		{ case_list_columns: [] },
		{ selection: { kind: "multiple", maximum: 5 } },
	]) {
		expect(module.safeParse({ name: "Visits", ...extra }).success).toBe(false);
	}
	const form = authoringToolSchema(
		"createForm",
		createFormInputSchema,
	).authored;
	for (const extra of [
		{ fields: [] },
		{ recordName: "'Name'" },
		{ close_condition: null },
		{ carry_search_answers: true },
	]) {
		expect(
			form.safeParse({
				moduleUuid: "Visits",
				name: "Register",
				type: "registration",
				...extra,
			}).success,
		).toBe(false);
	}
});

it("retains the independently authored parent-record selection route when constructing a module", () => {
	const parentCaseModuleUuid = asUuid("00000000-0000-4000-8000-000000000010");
	const parentModuleUuid = asUuid("00000000-0000-4000-8000-000000000011");
	const mutations = addModuleMutations({
		name: "Visits",
		parentCaseModuleUuid,
		parentModuleUuid,
		caseType: "visit",
	});
	expect(mutations).toMatchObject([
		{
			kind: "addModule",
			module: { parentCaseModuleUuid, parentModuleUuid, caseType: "visit" },
		},
	]);
});
