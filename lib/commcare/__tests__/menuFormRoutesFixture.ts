import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";

export const ROUTE = testUuid("clinic-menu");
export const SOURCE = testUuid("patients-menu");
export const REGISTER = testUuid("register-patient");
export const VISIT = testUuid("check-patient");

export function twoMenus() {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Patient name") }],
			},
		],
		modules: [
			{
				uuid: SOURCE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: REGISTER,
						name: "Register",
						type: "registration",
						fields: [
							f({
								id: "name",
								kind: "text",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
					{
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						fields: [f({ id: "notes", kind: "text" })],
					},
				],
			},
		],
	});
	doc.modules[ROUTE] = {
		uuid: ROUTE,
		id: "clinic",
		name: "Clinic",
		caseListConfig: caseListConfig([{ field: "case_name", header: "Patient" }]),
		entryPoint: { uuid: testUuid("clinic-entry"), id: "clinic" },
		formsFromMenu: {
			menuUuid: SOURCE,
			excludedFormUuids: [REGISTER],
			entryPoints: [
				{
					formUuid: VISIT,
					entryPoint: { uuid: testUuid("clinic-visit"), id: "clinic-visit" },
				},
			],
		},
	};
	doc.formOrder[ROUTE] = [];
	doc.moduleOrder = [ROUTE, SOURCE];
	doc.forms[VISIT].entryPoint = {
		uuid: testUuid("source-visit"),
		id: "visit",
		ignoreDisplayConditions: true,
	};
	return doc;
}
