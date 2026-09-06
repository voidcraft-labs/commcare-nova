import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";

export const caseCaptureScenarios = [
	"registration",
	"followup",
	"repeat",
	"query",
] as const;
export function caseCaptureFixture(
	scenario: (typeof caseCaptureScenarios)[number] | "multiple",
) {
	const repeated = scenario === "repeat" || scenario === "query";
	const type = repeated ? "wound" : "patient";
	const captures = [
		f({
			kind: "image",
			id: "thepicture",
			label: proseText("Photo"),
			relevant: "#form/show = 'yes'",
			caseWrite: { caseType: type, property: "photo", mode: "attachment" },
		}),
		f({
			kind: "file",
			id: "scan",
			label: proseText("Scan"),
			relevant: "#form/show = 'yes'",
			caseWrite: { caseType: type, property: "scan_url", mode: "url" },
		}),
	];
	return buildDoc({
		appName: "Case capture evidence",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					...(!repeated
						? [
								{ name: "photo", label: proseText("Photo") },
								{ name: "scan_url", label: proseText("Scan") },
							]
						: []),
				],
			},
			...(repeated
				? [
						{
							name: "wound",
							parent_type: "patient",
							properties: [
								{ name: "case_name", label: proseText("Wound") },
								{ name: "photo", label: proseText("Photo") },
								{ name: "scan_url", label: proseText("Scan") },
							],
						},
					]
				: []),
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					...(scenario === "multiple"
						? { selection: { kind: "multiple", maximum: 10 } }
						: {}),
				},
				forms: [
					{
						name: "Assess",
						type: scenario === "registration" ? "registration" : "followup",
						fields: [
							f({
								kind: "text",
								id: "show",
								label: proseText("Show captures"),
							}),
							...(!repeated
								? [
										f({
											kind: "text",
											id: "full_name",
											label: proseText("Name"),
											caseWrite: { caseType: "patient", property: "case_name" },
										}),
									]
								: []),
							...(repeated
								? [
										f({
											kind: "repeat",
											id: "wounds",
											label: proseText("Wounds"),
											...(scenario === "query"
												? {
														repeat_mode: "query_bound",
														data_source: { ids_query: "'first second'" },
													}
												: { repeat_mode: "user_controlled" }),
											children: [
												f({
													kind: "text",
													id: "site",
													label: proseText("Site"),
													caseWrite: {
														caseType: "wound",
														property: "case_name",
													},
												}),
												f({ kind: "group", id: "details", children: captures }),
											],
										}),
									]
								: [f({ kind: "group", id: "details", children: captures })]),
						],
					},
				],
			},
			...(repeated
				? [
						{
							name: "Wounds",
							caseType: "wound",
							caseListOnly: true,
							caseListConfig: caseListConfig([
								{ field: "case_name", header: "Name" },
							]),
							forms: [],
						},
					]
				: []),
		],
	});
}
