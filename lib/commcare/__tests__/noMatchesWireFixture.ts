import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	NEW_APP_SETTINGS,
	simpleSearchInputDef,
} from "@/lib/domain";
import { input, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../validator/runner";
export function admitNoMatchesDoc(doc: BlueprintDoc) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings, null, 2));
}
export const HOST_MODULE = testUuid("00000000-0000-4000-8000-0000000b0010");
export const FOLLOWUP_FORM = testUuid("00000000-0000-4000-8000-0000000b0011");
export const REGISTER_FORM = testUuid("00000000-0000-4000-8000-0000000b0012");
export const NAME_INPUT = testUuid("00000000-0000-4000-8000-0000000b0001");
export const NAME_FIELD = testUuid("00000000-0000-4000-8000-0000000b0020");
export const HOUSEHOLD_MODULE = testUuid(
	"00000000-0000-4000-8000-0000000b0030",
);

/**
 * A "Patients" module whose forms read the search, with one prompt
 * `patient_name`, one followup menu form, and one case list registration
 * form offered after an empty search, whose name field defaults to
 * `#search/patient_name`. `bareCaseList` drops the followup form and lists
 * the case list as the menu's entry.
 */
export function noMatchesDoc(
	options: { readonly label?: string; readonly bareCaseList?: boolean } = {},
): BlueprintDoc {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.searchInputs = [
		simpleSearchInputDef(
			NAME_INPUT,
			"patient_name",
			"Patient name",
			"text",
			"case_name",
		),
	];
	const registerForm = {
		uuid: REGISTER_FORM,
		name: "Register patient",
		type: "registration" as const,
		fields: [
			f({
				uuid: NAME_FIELD,
				kind: "text",
				id: "case_name",
				label: proseText("Name"),
				caseWrite: { caseType: "patient", property: "case_name" },
				default_value: term(input(NAME_INPUT)),
			}),
		],
	};
	const doc = buildDoc({
		appName: "Registry",
		// The registration form lives in a menu whose forms read the search,
		// which runs in Web Apps alone.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		modules: [
			{
				uuid: HOST_MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: { formsReadSearch: true },
				caseListRegistrationForm: {
					formUuid: REGISTER_FORM,
					...(options.label !== undefined && { label: options.label }),
				},
				...(options.bareCaseList === true
					? { caseListMenuItem: {}, forms: [registerForm] }
					: {
							forms: [
								{
									uuid: FOLLOWUP_FORM,
									name: "Visit",
									type: "followup" as const,
									fields: [
										f({
											kind: "text",
											id: "note",
											label: proseText("Note"),
										}),
									],
								},
								registerForm,
							],
						}),
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
	admitNoMatchesDoc(doc);
	return doc;
}

export const noMatchesWireScenarios = [
	"basic",
	"bare",
	"parent",
	"parent-bare",
	"home",
	"multiple-home",
] as const;
export function noMatchesWireFixture(
	scenario: (typeof noMatchesWireScenarios)[number],
) {
	let doc = noMatchesDoc({
		bareCaseList: scenario === "bare" || scenario === "parent-bare",
	});
	if (scenario === "parent" || scenario === "parent-bare") {
		const base = doc;
		doc = {
			...base,
			modules: {
				...base.modules,
				[HOUSEHOLD_MODULE]: {
					...base.modules[HOST_MODULE],
					uuid: HOUSEHOLD_MODULE,
					id: "households",
					name: "Households",
					caseListMenuItem: {},
					caseType: "household",
					caseSearchConfig: undefined,
					caseListRegistrationForm: undefined,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
			},
			moduleOrder: [...base.moduleOrder, HOUSEHOLD_MODULE],
			formOrder: { ...base.formOrder, [HOUSEHOLD_MODULE]: [] },
			caseTypes: [
				...(base.caseTypes ?? []).map((caseType) =>
					caseType.name === "patient"
						? { ...caseType, parent_type: "household" }
						: caseType,
				),
				{
					name: "household",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
		};
	}
	// Each edit makes a new document: plans are memoized per document object,
	// and `noMatchesDoc` has already planned the one it returned.
	if (scenario === "home" || scenario === "multiple-home") {
		const base = doc;
		doc = {
			...base,
			forms: {
				...base.forms,
				[REGISTER_FORM]: {
					...base.forms[REGISTER_FORM],
					postSubmit: "firstMenu",
				},
			},
		};
	}
	if (scenario === "multiple-home") {
		const base = doc;
		const host = base.modules[HOST_MODULE];
		const config = host.caseListConfig;
		if (!config) throw new Error("Missing search case list");
		doc = {
			...base,
			modules: {
				...base.modules,
				[HOST_MODULE]: {
					...host,
					caseListConfig: {
						...config,
						selection: { kind: "multiple", maximum: 5 },
					},
				},
			},
		};
	}
	admitNoMatchesDoc(doc);
	return doc;
}
