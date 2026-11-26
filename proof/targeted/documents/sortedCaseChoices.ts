import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	and,
	eq,
	formField,
	literal,
	lt,
	matchAll,
	prop,
} from "@/lib/domain/expression";
import { targetedDocument, targetedUuid } from "../build";

const id = "targeted-sorted-case-choices";
const uuid = (name: string) => targetedUuid(id, name);
const regionMatches = eq(prop("clinic", "region"), formField(uuid("region")));
const firstTwo = lt({ kind: "call", fn: "position", args: [] }, literal(3));

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
							...(
								[
									{ key: "type_order", label: "All clinics" },
									{
										key: "source_order",
										label: "Source order",
										filter: regionMatches,
									},
									{
										key: "sorted",
										label: "Sorted clinics",
										filter: regionMatches,
										sortProperty: "rank",
									},
									{
										key: "limited",
										label: "Limit before sorting",
										filter: and(firstTwo, regionMatches),
										sortProperty: "rank",
									},
								] as const
							).map(({ key, label, ...query }) =>
								f({
									uuid: uuid(key),
									kind: "single_select",
									id: key,
									label,
									optionsSource: {
										kind: "cases",
										caseType: "clinic",
										labelProperty: "case_name",
										...query,
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

export function caseChoiceReopen() {
	const id = "targeted-case-choice-reopen";
	const doc = buildDoc({
		appId: id,
		appName: "Clinic choice recovery",
		caseTypes: [
			{
				name: "clinic",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
		],
		modules: [
			{
				name: "Directory",
				forms: [
					{
						name: "Resume a clinic choice",
						uuid: targetedUuid(id, "choose"),
						type: "survey",
						fields: [
							f({
								uuid: targetedUuid(id, "clinic"),
								kind: "single_select",
								id: "clinic",
								label: "Clinic",
								required: matchAll(),
								optionsSource: {
									kind: "cases",
									caseType: "clinic",
									labelProperty: "case_name",
									filter: eq(prop("clinic", "region"), literal("north")),
								},
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["questions, queried choices after incomplete form reopen"],
		doc,
		expected: { intent: [] },
	});
}
