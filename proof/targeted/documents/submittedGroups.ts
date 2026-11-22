import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

/** The worker sees the household question between the two visit questions.
 * A submission keeps it under household and preserves the intervening
 * data-only note, as Vellum does when an author sets a Data Parent. */
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
								submissionPlacement: { parent: group, position: 0 },
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
								submissionPlacement: { parent: form, position: 1 },
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
