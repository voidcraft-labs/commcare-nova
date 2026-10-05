/** The two native Previous task shapes over saved real records. */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { buildUrl } from "@/lib/routing/location";

export const PREVIOUS_TASK_SEED = {
	appName: "Smoke previous tasks",
	formsFirst: {
		moduleUuid: testUuid("previous-forms-first"),
		formUuid: testUuid("previous-update"),
		moduleName: "Repair visits",
		formName: "Update repair",
		caseType: "repair",
		caseName: "Repair A",
		fieldLabel: "Repair state",
	},
	caseFirst: {
		moduleUuid: testUuid("previous-case-first"),
		closeFormUuid: testUuid("previous-close"),
		inspectFormUuid: testUuid("previous-inspect"),
		moduleName: "Ticket tasks",
		closeFormName: "Close ticket",
		inspectFormName: "Inspect ticket",
		caseType: "ticket",
		caseName: "Ticket A",
		fieldLabel: "Ticket state",
	},
} as const;

export function buildPreviousTaskBlueprint(appId: string) {
	const { formsFirst, caseFirst } = PREVIOUS_TASK_SEED;
	return buildDoc({
		appId,
		appName: PREVIOUS_TASK_SEED.appName,
		caseTypes: [formsFirst, caseFirst].map(({ caseType }) => ({
			name: caseType,
			properties: [
				{ name: "condition", label: "State", data_type: "text" as const },
			],
		})),
		modules: [
			{
				uuid: formsFirst.moduleUuid,
				name: formsFirst.moduleName,
				caseType: formsFirst.caseType,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Repair" },
					{ field: "condition", header: "State" },
				]),
				forms: [
					{
						uuid: formsFirst.formUuid,
						name: formsFirst.formName,
						type: "followup",
						postSubmit: "previous",
						fields: [
							f({
								kind: "text",
								id: "state",
								label: formsFirst.fieldLabel,
								caseWrite: {
									caseType: formsFirst.caseType,
									property: "condition",
								},
							}),
						],
						formLinks: [
							{
								condition: "#repair/condition = 'Transfer'",
								target: { type: "module", moduleUuid: formsFirst.moduleUuid },
							},
						],
					},
					{
						name: "Register repair",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: "Repair name",
								caseWrite: {
									caseType: formsFirst.caseType,
									property: "case_name",
								},
							}),
						],
					},
				],
			},
			{
				uuid: caseFirst.moduleUuid,
				name: caseFirst.moduleName,
				caseType: caseFirst.caseType,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Ticket" },
					{ field: "condition", header: "State" },
				]),
				forms: [
					{
						uuid: caseFirst.closeFormUuid,
						name: caseFirst.closeFormName,
						type: "close",
						postSubmit: "previous",
						fields: [
							f({
								kind: "text",
								id: "state",
								label: caseFirst.fieldLabel,
								caseWrite: {
									caseType: caseFirst.caseType,
									property: "condition",
								},
							}),
						],
					},
					{
						uuid: caseFirst.inspectFormUuid,
						name: caseFirst.inspectFormName,
						type: "followup",
						postSubmit: "module",
						fields: [
							f({
								kind: "text",
								id: "state",
								label: caseFirst.fieldLabel,
								caseWrite: {
									caseType: caseFirst.caseType,
									property: "condition",
								},
							}),
						],
					},
				],
			},
		],
	});
}

export function previousTaskRoutes(appId: string) {
	return {
		formsFirst: buildUrl(`/build/${appId}`, {
			kind: "module",
			moduleUuid: PREVIOUS_TASK_SEED.formsFirst.moduleUuid,
		}),
		caseFirst: buildUrl(`/build/${appId}`, {
			kind: "module",
			moduleUuid: PREVIOUS_TASK_SEED.caseFirst.moduleUuid,
		}),
	};
}
