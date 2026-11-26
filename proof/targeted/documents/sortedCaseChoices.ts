import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { eq, formField, prop } from "@/lib/domain/expression";
import { targetedDocument, targetedUuid } from "../build";

const id = "targeted-sorted-case-choices";
const uuid = (name: string) => targetedUuid(id, name);

export function sortedCaseChoices() {
	const doc = buildDoc({
		appId: id,
		appName: "Clinic choices",
		caseTypes: [
			{
				name: "clinic",
				properties: [
					{ name: "region", label: "Region", data_type: "text" },
					{ name: "rank", label: "Order", data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Directory",
				forms: [
					{
						name: "Choose a clinic",
						uuid: uuid("choose"),
						type: "survey",
						fields: [
							f({
								uuid: uuid("region"),
								kind: "text",
								id: "region",
								label: "Region",
							}),
							...(["source_order", "sorted"] as const).map((key) =>
								f({
									uuid: uuid(key),
									kind: "single_select",
									id: key,
									label: key === "sorted" ? "Sorted clinics" : "Source order",
									optionsSource: {
										kind: "cases",
										caseType: "clinic",
										labelProperty: "case_name",
										filter: eq(
											prop("clinic", "region"),
											formField(uuid("region")),
										),
										...(key === "sorted" && { sortProperty: "rank" }),
									},
								}),
							),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["questions, itemset sort reference"],
		doc,
		expected: { intent: [] },
	});
}
