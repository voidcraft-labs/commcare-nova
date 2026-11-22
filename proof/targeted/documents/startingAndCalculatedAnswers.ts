import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { targetedDocument, targetedUuid } from "../build";

export function startingAndCalculatedAnswers() {
	const id = "targeted-starting-and-calculated-answers";
	const form = targetedUuid(id, "visit");
	const doc = buildDoc({
		appId: id,
		appName: "Visit readings",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							f({ kind: "text", id: "show_details", label: "Show details" }),
							f({
								kind: "hidden",
								id: "stage",
								default_value: "'first'",
								calculate: "'current'",
							}),
							f({
								kind: "text",
								id: "captured",
								label: "Stage at opening",
								default_value: "#form/stage",
							}),
							f({
								kind: "group",
								id: "later",
								label: "Details",
								relevant: "#form/show_details = 'yes'",
								children: [
									f({
										kind: "hidden",
										id: "detail_level",
										default_value: "'three'",
										calculate: "'five'",
									}),
								],
							}),
							f({
								kind: "group",
								id: "never",
								label: "Archived details",
								relevant: "false()",
								children: [
									f({
										kind: "hidden",
										id: "archived_level",
										default_value: "'three'",
										calculate: "'five'",
									}),
								],
							}),
							f({
								kind: "text",
								id: "before_check",
								label: "Opening reading",
								default_value: "#form/later/detail_level",
							}),
							f({
								kind: "text",
								id: "absent",
								label: "Archived reading",
								default_value: "#form/never/archived_level",
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: [
			"The value seen by a later starting answer before a calculation runs",
		],
		doc,
		expected: {
			intent: (["local", "A"] as const).map((target) => ({
				id: `opening-answers-${target}`,
				export: target,
				form,
				request: {
					expressions: [
						"/data/captured",
						"/data/stage",
						"/data/before_check",
						"/data/absent",
					],
				},
				expect: [
					{ pointer: "/values/0/value", value: "first" },
					{ pointer: "/values/1/value", value: "current" },
					{ pointer: "/values/2/value", value: "three" },
					{ pointer: "/values/3/value", value: "" },
				],
			})),
		},
	});
}
