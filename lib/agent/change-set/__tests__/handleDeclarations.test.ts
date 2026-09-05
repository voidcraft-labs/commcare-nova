/** Shared structural tools declare handles only in their creation slots. */

import { describe, expect, it } from "vitest";
import { CREATION_IDENTITY_SPECS } from "@/lib/agent/change-set/creationIdentities";
import { sharedHandleDeclarer } from "@/lib/agent/change-set/handleDeclarations";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";

function declarations(toolName: string, input: unknown) {
	const declarer = sharedHandleDeclarer(toolName);
	if (declarer === undefined) throw new Error(`No declarer for ${toolName}`);
	return declarer(input);
}

describe("shared creation handle declarations", () => {
	it("declares an entry point without redeclaring its module or form target", () => {
		expect(
			declarations("addEntryPoint", {
				entryPointUuid: { handle: "@visit_link" },
				target: {
					kind: "form",
					moduleUuid: { handle: "@patients" },
					formUuid: { handle: "@visit" },
				},
			}),
		).toEqual([{ handle: "@visit_link", entityKind: "entry_point" }]);
	});
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

	it("binds organization and automation identities without model-minted UUIDs", () => {
		expect(
			declarations("addUserProperties", {
				properties: [{ userPropertyUuid: { handle: "@worker_role" } }],
			}),
		).toEqual([{ handle: "@worker_role", entityKind: "worker_property" }]);
		expect(
			declarations("addUserTypes", {
				userTypes: [{ userTypeUuid: { handle: "@supervisor" } }],
			}),
		).toEqual([{ handle: "@supervisor", entityKind: "user_type" }]);
		expect(
			declarations("addPersonas", {
				personas: [{ personaUuid: { handle: "@field_worker" } }],
			}),
		).toEqual([{ handle: "@field_worker", entityKind: "persona" }]);
		expect(
			declarations("addLocationProperties", {
				properties: [{ locationPropertyUuid: { handle: "@facility_code" } }],
			}),
		).toEqual([{ handle: "@facility_code", entityKind: "location_property" }]);

		expect(
			declarations("addOrganizationLevels", {
				levels: [{ uuid: { handle: "@district" } }],
			}),
		).toEqual([{ handle: "@district", entityKind: "organization_level" }]);

		expect(
			declarations("addAutomations", {
				automations: [
					{
						kind: "case-update",
						uuid: { handle: "@follow_up" },
						criteria: [{ uuid: { handle: "@due" } }],
						setupOnlyCriteria: [{ uuid: { handle: "@configured" } }],
						updates: [{ uuid: { handle: "@mark_due" } }],
					},
				],
			}),
		).toEqual([
			{ handle: "@follow_up", entityKind: "automation" },
			{ handle: "@due", entityKind: "automation_criterion" },
			{
				handle: "@configured",
				entityKind: "automation_setup_criterion",
			},
			{ handle: "@mark_due", entityKind: "automation_update" },
		]);

		expect(
			declarations("updateAutomation", {
				automation: {
					kind: "communication",
					uuid: { handle: "@existing" },
					recipients: [{ uuid: { handle: "@caregiver" } }],
					schedule: { events: [{ uuid: { handle: "@day_three" } }] },
					userDataFilters: [{ uuid: { handle: "@program" } }],
				},
			}),
		).toEqual([
			{
				handle: "@caregiver",
				entityKind: "automation_recipient",
				referenceIfBound: true,
			},
			{
				handle: "@day_three",
				entityKind: "automation_event",
				referenceIfBound: true,
			},
			{
				handle: "@program",
				entityKind: "automation_user_data_filter",
				referenceIfBound: true,
			},
		]);
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
			"addUserProperties",
			"addUserTypes",
			"addPersonas",
			"addOrganizationLevels",
			"addLocationProperties",
			"addAutomations",
			"updateAutomation",
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

	it("every creation-identity tool binds its declarations in the registry", () => {
		/* The wire projection narrows exactly the annotated table's paths to
		 * required handles; every tool in that table must therefore have a
		 * registry declarer (stage or shared), or the wire would demand a
		 * handle the workspace never binds and every dispatch would die on
		 * "handle is not bound". */
		for (const toolName of Object.keys(CREATION_IDENTITY_SPECS)) {
			expect(
				CHANGE_SET_TOOL_REGISTRY.get(toolName)?.declaredHandles,
				`registry declarer missing for ${toolName}`,
			).toBeDefined();
		}
	});
});
