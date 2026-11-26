import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

/** The worker sees the household question between the two visit questions.
 * The answer is submitted under household. The data-only note follows
 * the remaining screen fields in the order Vellum saves. */
export function submittedGroups() {
	const id = "targeted-submitted-groups";
	const uuid = (key: string) => targetedUuid(id, key);
	const form = uuid("form");
	const group = uuid("household");
	const doc = buildDoc({
		appId: id,
		appName: "Household visit",
		modules: [
			{
				uuid: uuid("menu"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Arrival",
						type: "survey",
						fields: [
							f({
								uuid: uuid("before"),
								kind: "text",
								id: "arrival",
								label: proseText("Who greeted you?"),
							}),
							f({
								uuid: uuid("child"),
								kind: "text",
								id: "name",
								label: proseText("Household name"),
								submissionPlacement: { parent: group },
							}),
							f({
								uuid: uuid("after"),
								kind: "text",
								id: "next",
								label: proseText("What happens next?"),
							}),
							f({ uuid: group, kind: "group", id: "household", children: [] }),
							f({
								uuid: uuid("note"),
								kind: "hidden",
								id: "visit_note",
							}),
						],
					},
					{
						uuid: uuid("relevance"),
						name: "Check visit details",
						type: "survey",
						fields: [
							f({
								uuid: uuid("include"),
								kind: "text",
								id: "include_details",
								label: proseText("Include details?"),
								default_value: "'no'",
							}),
							f({
								kind: "group",
								uuid: uuid("details"),
								id: "details",
								label: proseText("Visit details"),
								relevant: "#form/include_details = 'yes'",
								children: [
									f({
										uuid: uuid("result"),
										kind: "text",
										id: "result",
										label: proseText("Review result"),
										default_value: "'reviewed'",
										submissionPlacement: { parent: uuid("receipt") },
									}),
									f({
										uuid: uuid("notice"),
										kind: "label",
										id: "notice",
										label: proseText("Read the visit notes"),
										submissionPlacement: { parent: uuid("receipt") },
									}),
								],
							}),
							f({
								uuid: uuid("receipt"),
								kind: "group",
								id: "receipt",
								label: proseText("Receipt"),
								children: [],
							}),
							f({
								uuid: uuid("finding"),
								kind: "text",
								id: "finding",
								label: proseText("Finding"),
								default_value: "'clear'",
								submissionPlacement: { parent: uuid("details") },
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		doc,
		rows: [
			"questions/data-parent-data-node-under-another-group-than-its-control",
		],
		expected: {
			intent: [
				answerHeld(
					"submitted-in-household",
					form,
					"/data/household/name",
					"Chen",
				),
			],
		},
	});
}
