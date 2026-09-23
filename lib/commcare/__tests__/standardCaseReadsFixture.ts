import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";

/** No custom declaration of platform metadata; own and parent reads must work. */
export function standardCaseReadsFixture() {
	return buildDoc({
		appName: "Record metadata",
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "visit", parent_type: "household", properties: [] },
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Visit" },
				]),
				forms: [
					{
						name: "Check record",
						type: "followup",
						fields: [
							f({ kind: "text", id: "note", label: proseText("Note") }),
							...["visit", "household"].flatMap((type) =>
								[
									"case_id",
									"case_name",
									"owner_id",
									"status",
									"external_id",
									"date_opened",
									"last_modified",
								].map((property) =>
									f({
										kind: "hidden",
										id: `${type}_${property}`,
										calculate: `string(#${type}/${property})`,
									}),
								),
							),
						],
					},
				],
			},
		],
	});
}
