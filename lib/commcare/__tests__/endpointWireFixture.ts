import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, simpleSearchInputDef } from "@/lib/domain";
import { runValidation } from "../validator/runner";
export const endpointScenarios = [
	"single",
	"multiple",
	"inline",
	"registration",
	"child",
	"module",
	"case-list",
] as const;
export const ENDPOINT_MODULE = testUuid("endpoint-module"),
	ENDPOINT_FORM = testUuid("endpoint-form");
export function endpointWireFixture(
	scenario: (typeof endpointScenarios)[number] = "single",
) {
	const child = scenario === "child",
		type = child ? "baby" : "patient";
	const doc = buildDoc({
		appName: "Entry points",
		caseTypes: child
			? [
					{ name: "mother", properties: [] },
					{ name: "baby", parent_type: "mother", properties: [] },
				]
			: [{ name: "patient", properties: [] }],
		modules: [
			...(child
				? [
						{
							uuid: testUuid("endpoint-parent"),
							name: "Mothers",
							caseType: "mother",
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Name" },
							]),
							forms: [
								{
									name: "Register mother",
									type: "registration" as const,
									fields: [
										f({
											kind: "text",
											id: "mother_name",
											caseWrite: { caseType: "mother", property: "case_name" },
										}),
									],
								},
							],
						},
					]
				: []),
			{
				uuid: ENDPOINT_MODULE,
				name: child ? "Babies" : "Patients",
				caseType: type,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: ENDPOINT_FORM,
						name: "Visit",
						type: scenario === "registration" ? "registration" : "followup",
						fields: [
							f({
								kind: "text",
								id: "notes",
								...(scenario === "registration"
									? { caseWrite: { caseType: type, property: "case_name" } }
									: {}),
							}),
						],
					},
				],
			},
		],
	});
	const module = doc.modules[ENDPOINT_MODULE],
		form = doc.forms[ENDPOINT_FORM];
	const entryPoint = { uuid: testUuid("endpoint-identity"), id: "visit" };
	if (scenario === "module") module.entryPoint = entryPoint;
	else if (scenario === "case-list") module.caseListEntryPoint = entryPoint;
	else
		form.entryPoint = {
			...entryPoint,
			...(scenario === "registration"
				? { ignoreDisplayConditions: true as const }
				: {}),
		};
	if (child) module.parentModuleUuid = testUuid("endpoint-parent");
	if (!module.caseListConfig) throw new Error("Missing case list");
	if (scenario === "multiple")
		module.caseListConfig.selection = { kind: "multiple", maximum: 5 };
	if (scenario === "inline") {
		module.caseSearchConfig = { searchFirst: true };
		module.caseListConfig.searchInputs = [
			simpleSearchInputDef(
				testUuid("endpoint-search"),
				"case_name",
				"Name",
				"text",
				"case_name",
			),
		];
	}
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length)
		throw new Error(JSON.stringify({ scenario, findings }, null, 2));
	return doc;
}
