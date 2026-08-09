/** Shared structural tools declare handles only in their creation slots. */

import { describe, expect, it } from "vitest";
import { sharedHandleDeclarer } from "@/lib/agent/change-set/handleDeclarations";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";

function declarations(toolName: string, input: unknown) {
	const declarer = sharedHandleDeclarer(toolName);
	if (declarer === undefined) throw new Error(`No declarer for ${toolName}`);
	return declarer(input);
}

describe("shared creation handle declarations", () => {
	it("binds every nested identity created by createModule", () => {
		expect(
			declarations("createModule", {
				moduleUuid: { handle: "@registry" },
				forms: [
					{
						formUuid: { handle: "@registration" },
						fields: [
							{ fieldUuid: { handle: "@name" } },
							{
								fieldUuid: { handle: "@status" },
								optionsSource: {
									kind: "inline",
									options: [
										{ optionUuid: { handle: "@active" } },
										{ optionUuid: { handle: "@closed" } },
									],
								},
							},
						],
					},
				],
				case_list_columns: [{ columnUuid: { handle: "@display_name" } }],
			}),
		).toEqual([
			{ handle: "@registry", entityKind: "module" },
			{ handle: "@registration", entityKind: "form" },
			{ handle: "@name", entityKind: "field" },
			{ handle: "@status", entityKind: "field" },
			{ handle: "@active", entityKind: "option" },
			{ handle: "@closed", entityKind: "option" },
			{ handle: "@display_name", entityKind: "case_list_column" },
		]);
	});

	it("covers each shared bulk creation tool", () => {
		expect(
			declarations("createForm", {
				formUuid: { handle: "@visit" },
				fields: [{ fieldUuid: { handle: "@visit_date" } }],
			}),
		).toEqual([
			{ handle: "@visit", entityKind: "form" },
			{ handle: "@visit_date", entityKind: "field" },
		]);
		expect(
			declarations("addFields", {
				fields: [{ fieldUuid: { handle: "@notes" } }],
			}),
		).toEqual([{ handle: "@notes", entityKind: "field" }]);
		expect(
			declarations("addCaseListColumns", {
				columns: [{ columnUuid: { handle: "@name_column" } }],
			}),
		).toEqual([{ handle: "@name_column", entityKind: "case_list_column" }]);
		expect(
			declarations("addSearchInputs", {
				searchInputs: [{ searchInputUuid: { handle: "@query" } }],
			}),
		).toEqual([{ handle: "@query", entityKind: "search_input" }]);
		expect(
			declarations("addCaseOperations", {
				operations: [{ operationUuid: { handle: "@create_child" } }],
			}),
		).toEqual([{ handle: "@create_child", entityKind: "case_operation" }]);
	});

	it("never treats target slots or canonical UUIDs as declarations", () => {
		expect(
			declarations("addFields", {
				moduleUuid: { handle: "@existing_module" },
				formUuid: { handle: "@existing_form" },
				fields: [
					{
						fieldUuid: "11111111-1111-4111-8111-111111111111",
						parentUuid: { handle: "@existing_group" },
					},
				],
			}),
		).toEqual([]);
	});

	it("binds only nested options on replacement tools and preserves bound ones", () => {
		expect(
			declarations("editField", {
				fieldUuid: { handle: "@status" },
				updates: {
					optionsSource: {
						kind: "inline",
						options: [{ optionUuid: { handle: "@active" } }],
					},
				},
			}),
		).toEqual([
			{
				handle: "@active",
				entityKind: "option",
				referenceIfBound: true,
			},
		]);
		expect(
			declarations("setFieldOptionsSource", {
				fieldUuid: { handle: "@status" },
				source: {
					kind: "inline",
					options: [{ optionUuid: { handle: "@pending" } }],
				},
			}),
		).toEqual([
			{
				handle: "@pending",
				entityKind: "option",
				referenceIfBound: true,
			},
		]);
	});

	it("wires declaration readers onto the matching shared registry entries", () => {
		for (const toolName of [
			"createModule",
			"createForm",
			"addFields",
			"addCaseListColumns",
			"addSearchInputs",
			"addCaseOperations",
			"editField",
			"setFieldOptionsSource",
		]) {
			expect(CHANGE_SET_TOOL_REGISTRY.get(toolName)?.declaredHandles).toBe(
				sharedHandleDeclarer(toolName),
			);
		}
		expect(
			CHANGE_SET_TOOL_REGISTRY.get("moveField")?.declaredHandles,
		).toBeUndefined();
	});
});
