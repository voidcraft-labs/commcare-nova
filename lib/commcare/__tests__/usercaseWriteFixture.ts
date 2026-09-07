import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";

export const workerVisitsUuid = testUuid("worker-property-visits");
export function usercaseWriteFixture(type: "survey" | "followup") {
	const doc = buildDoc({
		appName: "Worker record wire",
		caseTypes:
			type === "followup"
				? [
						{
							name: "patient",
							properties: [{ name: "note", label: proseText("Note") }],
						},
					]
				: [],
		modules: [
			{
				name: "Visits",
				...(type === "followup" && {
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				}),
				forms: [
					{
						name: "Visit",
						type,
						fields: [
							f({
								kind: "text",
								id: "note",
								label: proseText("Note"),
								...(type === "followup" && {
									caseWrite: { caseType: "patient", property: "note" },
								}),
							}),
							f({
								kind: "text",
								id: "visits_so_far",
								label: proseText("Visits so far"),
								caseWrite: {
									caseType: "commcare-user",
									property: "visits_done",
								},
							}),
						],
					},
				],
			},
			...(type === "followup"
				? [
						{
							name: "Patient list",
							caseType: "patient",
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
	doc.userProperties = {
		[workerVisitsUuid]: {
			uuid: workerVisitsUuid,
			slug: "visits_done",
			label: "Visits so far",
		},
	};
	doc.userPropertyOrder = [workerVisitsUuid];
	return doc;
}
