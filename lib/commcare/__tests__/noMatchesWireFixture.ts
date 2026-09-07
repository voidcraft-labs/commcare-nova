import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	simpleSearchInputDef,
} from "@/lib/domain";
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
 * A search-first "Patients" module with one prompt `patient_name`, one
 * followup menu form, and one no-matches registration form whose name
 * field defaults to `#search/patient_name`.
 */
export function noMatchesDoc(
	options: { readonly label?: string; readonly caseListOnly?: boolean } = {},
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
		entry: {
			kind: "search-no-matches" as const,
			...(options.label !== undefined && { label: options.label }),
		},
		fields: [
			f({
				uuid: NAME_FIELD,
				kind: "text",
				id: "case_name",
				label: proseText("Name"),
				caseWrite: { caseType: "patient", property: "case_name" },
				default_value: {
					parts: [{ kind: "search-answer-ref", searchInputUuid: NAME_INPUT }],
				},
			}),
		],
	};
	const doc = buildDoc({
		appName: "Registry",
		modules: [
			{
				uuid: HOST_MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				caseSearchConfig: { searchFirst: true },
				...(options.caseListOnly === true
					? { caseListOnly: true, forms: [registerForm] }
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
		caseListOnly: scenario === "bare" || scenario === "parent-bare",
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
					caseListOnly: true,
					caseType: "household",
					caseSearchConfig: undefined,
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
	if (scenario === "home" || scenario === "multiple-home")
		doc.forms[REGISTER_FORM].postSubmit = "app_home";
	if (scenario === "multiple-home") {
		const config = doc.modules[HOST_MODULE].caseListConfig;
		if (!config) throw new Error("Missing search case list");
		config.selection = { kind: "multiple", maximum: 5 };
	}
	admitNoMatchesDoc(doc);
	return doc;
}
