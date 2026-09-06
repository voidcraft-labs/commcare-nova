import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";

export const extensionScenarios = [
	"registration",
	"followup",
	"repeat",
	"query",
	"multiple",
	"multiple-repeat",
] as const;
export type ExtensionScenario = (typeof extensionScenarios)[number];

export function extensionCaseFixture(scenario: ExtensionScenario) {
	const registration =
		scenario === "registration" ||
		scenario === "repeat" ||
		scenario === "query";
	const repeated =
		scenario === "repeat" ||
		scenario === "query" ||
		scenario === "multiple-repeat";
	const columns = () =>
		caseListConfig([{ field: "case_name", header: "Name" }]);
	const children = ["episode", "visit", "consent"].flatMap((caseType) => [
		f({
			kind: "text",
			id: `${caseType}_name`,
			label: proseText(`${caseType} name`),
			caseWrite: { caseType, property: "case_name" },
		}),
		f({
			kind: "text",
			id: `${caseType}_note`,
			label: proseText(`${caseType} note`),
			caseWrite: { caseType, property: "note" },
		}),
	]);
	children.push(
		f({
			kind: "image",
			id: "episode_photo",
			label: proseText("Episode photo"),
			caseWrite: { caseType: "episode", property: "photo", mode: "attachment" },
		}),
	);
	const doc = buildDoc({
		appName: "Extension case evidence",
		caseTypes: [
			{ name: "patient", properties: [] },
			...["episode", "visit", "consent"].map((name) => ({
				name,
				parent_type: "patient",
				relationship:
					name === "visit" ? ("child" as const) : ("extension" as const),
				properties: [
					{ name: "note", label: proseText("Note") },
					...(name === "episode"
						? [{ name: "photo", label: proseText("Photo") }]
						: []),
				],
			})),
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...columns(),
					...(scenario === "multiple" || scenario === "multiple-repeat"
						? { selection: { kind: "multiple" as const, maximum: 10 } }
						: {}),
				},
				forms: [
					{
						name: "Record care",
						type: registration ? "registration" : "followup",
						...(scenario === "registration"
							? {
									formLinks: [
										{
											target: {
												type: "form" as const,
												moduleUuid: testUuid("episodes"),
												formUuid: testUuid("review"),
											},
										},
									],
								}
							: {}),
						fields: [
							...(registration
								? [
										f({
											kind: "text",
											id: "patient_name",
											label: proseText("Patient name"),
											caseWrite: { caseType: "patient", property: "case_name" },
										}),
									]
								: []),
							...(repeated
								? [
										f({
											kind: "repeat",
											id: "records",
											label: proseText("Records"),
											repeat_mode:
												scenario === "query"
													? "query_bound"
													: "user_controlled",
											...(scenario === "query"
												? { data_source: { ids_query: "'one two'" } }
												: {}),
											children,
										}),
									]
								: children),
						],
					},
				],
			},
			{
				uuid: "episodes",
				name: "Episodes",
				caseType: "episode",
				caseListConfig: columns(),
				forms: [
					{
						uuid: "review",
						name: "Review episode",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "review_note",
								label: proseText("Review note"),
								caseWrite: { caseType: "episode", property: "note" },
							}),
						],
					},
				],
			},
			...["visit", "consent"].map((caseType) => ({
				name: caseType,
				caseType,
				caseListOnly: true,
				caseListConfig: columns(),
				forms: [],
			})),
		],
	});
	return doc;
}
