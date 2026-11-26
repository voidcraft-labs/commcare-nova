/** The deep-link journey owns a fresh app and two real cases per attempt.
 * A distractor sorts first, so falling back to the first case cannot pass. */
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { buildUrl } from "@/lib/routing/location";
import { buildFormLinksBlueprint, FORM_LINKS_SEED } from "./formLinksSeed";

export const DEEP_LINKS_SEED = {
	appName: "Smoke · Deep links",
	moduleName: FORM_LINKS_SEED.moduleName,
	moduleUuid: FORM_LINKS_SEED.moduleUuid,
	target: FORM_LINKS_SEED.followUp,
	caseType: FORM_LINKS_SEED.caseType,
	registration: {
		moduleName: "Intake",
		formName: "Register patient",
		fieldLabel: "Patient name",
	},
	distractorName: "A different patient",
	selectedName: "Z selected patient",
	renamedId: "selected_patient_follow_up",
} as const;

export function buildDeepLinksBlueprint(appId: string) {
	const doc = buildFormLinksBlueprint(appId);
	const { registration, caseType } = DEEP_LINKS_SEED;
	const intake = buildDoc({
		appId,
		modules: [
			{
				uuid: "deep-links-intake",
				name: registration.moduleName,
				caseType,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "deep-links-registration",
						name: registration.formName,
						type: "registration",
						postSubmit: "app_home",
						fields: [
							f({
								uuid: "deep-links-registration-name",
								kind: "text",
								id: "patient_name",
								label: registration.fieldLabel,
								caseWrite: { caseType, property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	return {
		...doc,
		appName: DEEP_LINKS_SEED.appName,
		moduleOrder: [...doc.moduleOrder, ...intake.moduleOrder],
		modules: { ...doc.modules, ...intake.modules },
		formOrder: { ...doc.formOrder, ...intake.formOrder },
		forms: { ...doc.forms, ...intake.forms },
		fields: { ...doc.fields, ...intake.fields },
		fieldOrder: { ...doc.fieldOrder, ...intake.fieldOrder },
		fieldParent: { ...doc.fieldParent, ...intake.fieldParent },
	};
}
export function deepLinksRoute(appId: string) {
	return buildUrl(`/build/${appId}`, {
		kind: "app-setup",
		section: "deep-links",
	});
}
