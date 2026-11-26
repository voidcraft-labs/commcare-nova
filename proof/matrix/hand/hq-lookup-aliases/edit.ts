import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";

/** Show the meeting site's code in the choice list. Its saved value and the
 * visit-type choices keep their original column and table identities. */
export function edit(doc: BlueprintDoc): readonly Mutation[] {
	const meetingSite = Object.values(doc.fields).find(
		(field) => field.id === "meeting_site",
	);
	if (
		meetingSite?.kind !== "single_select" ||
		meetingSite.optionsSource.kind !== "lookup"
	) {
		throw new Error(
			"The HQ visit form must have a meeting site choice from its table.",
		);
	}
	const source = meetingSite.optionsSource;
	return [
		{
			kind: "updateField",
			uuid: meetingSite.uuid,
			targetKind: "single_select",
			patch: {
				optionsSource: { ...source, labelColumnId: source.valueColumnId },
			},
		},
	];
}
