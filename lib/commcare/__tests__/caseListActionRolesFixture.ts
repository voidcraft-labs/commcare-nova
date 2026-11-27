import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	formField,
	literal,
	neq,
	term,
} from "@/lib/domain/expression/builders";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";

export const actionRoleIds = {
	households: testUuid("action-households"),
	registerList: testUuid("action-register-list"),
	parentList: testUuid("action-parent-list"),
	householdForms: testUuid("action-household-forms"),
	edit: testUuid("action-edit-parent"),
	register: testUuid("action-joint-registration"),
	newPerson: testUuid("action-joint-person"),
	personName: testUuid("action-person-name"),
} as const;

/** Two lists reached after choosing a household. One creates a household and
 * person in one entry and returns with the person. The other opens a separate
 * household follow-up with the selected household. */
export function caseListActionRolesFixture(
	advanced = false,
	options: { saveParentNote?: boolean } = {},
) {
	const id = actionRoleIds;
	const list = (name: string) => {
		const column = plainColumn(
			testUuid(`list-action-${name}-name`),
			"case_name",
			"Name",
		);
		return {
			columns: [column],
			listColumnOrder: [column.uuid],
			detailColumnOrder: [column.uuid],
			searchInputs: [],
		};
	};
	const follow = (name: string, saveNote = false) => ({
		uuid: testUuid(name),
		name,
		type: "followup" as const,
		fields: [
			f({
				uuid: testUuid(`list-action-${name}-note`),
				kind: "text",
				id: "note",
				label: proseText("Note"),
				...(saveNote && {
					caseWrite: { caseType: "household", property: "last_note" },
				}),
			}),
		],
	});
	const doc = buildDoc({
		appName: "Household visits",
		caseTypes: [
			{
				name: "household",
				properties: options.saveParentNote
					? [{ name: "last_note", label: proseText("Last note") }]
					: [],
			},
			{ name: "person", parent_type: "household", properties: [] },
		],
		modules: [
			{
				uuid: id.households,
				name: "Choose a household",
				caseType: "household",
				caseListConfig: list("households"),
				forms: [follow("See household")],
			},
			{
				uuid: id.registerList,
				name: "New members",
				caseType: "person",
				parentCaseModuleUuid: id.households,
				caseListConfig: list("register"),
				forms: [follow("Visit member")],
			},
			{
				uuid: id.parentList,
				name: "Existing members",
				caseType: "person",
				parentCaseModuleUuid: id.households,
				caseListConfig: list("parent"),
				forms: [follow("Check member")],
			},
			{
				uuid: id.householdForms,
				name: "Household forms",
				caseType: "household",
				caseListConfig: list("forms"),
				forms: [
					{
						...follow("Edit household", options.saveParentNote),
						uuid: id.edit,
					},
					{
						uuid: id.register,
						name: "Register household and member",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: testUuid("list-action-household-name"),
								id: "household_name",
								label: proseText("Household name"),
								caseWrite: { caseType: "household", property: "case_name" },
							}),
							f({
								kind: "text",
								uuid: id.personName,
								id: "member_name",
								label: proseText("Member name"),
							}),
						],
					},
				],
			},
		],
	});
	const form = doc.forms[id.register];
	const own = form.caseOperations?.find(
		(operation) => operation.action === "own",
	);
	if (own === undefined)
		throw new Error("Registration must create the household.");
	form.caseOperations = [
		...(form.caseOperations ?? []),
		{
			action: "create",
			id: "new_member",
			uuid: id.newPerson,
			caseType: "person",
			target: { kind: "new" },
			name: term(formField(id.personName)),
			links: [
				{
					identifier: "parent",
					relationship: "child",
					targetType: "household",
					target: { kind: "op", opUuid: own.uuid },
				},
			],
		},
	];
	if (advanced) doc.modules[id.householdForms].heldKind = "advanced";
	doc.modules[id.registerList].caseListRegistrationForm = {
		kind: "always",
		formUuid: id.register,
		target: { kind: "created-case", operationUuid: id.newPerson },
		showWhen: {
			kind: "condition",
			condition: neq(
				{
					kind: "session-datum",
					datum: { kind: "selected-case", module: id.households },
				},
				literal("closed-to-new-members"),
			),
		},
		label: "Add a household and member",
		afterSubmit: "new-case",
	};
	doc.modules[id.parentList].caseListRegistrationForm = {
		kind: "always",
		formUuid: id.edit,
		target: { kind: "chosen-parent", moduleUuid: id.households },
		label: "Edit this household",
		afterSubmit: "new-case",
	};
	return doc;
}
