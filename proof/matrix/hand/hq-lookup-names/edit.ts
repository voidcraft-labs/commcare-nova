import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";

/** A visit records the same zone code after the person asks to display that
 * code as the choice label too. Both column identities came from HQ. */
export function edit(doc: BlueprintDoc): readonly Mutation[] {
	const zone = Object.values(doc.fields).find((field) => field.id === "zone");
	if (zone?.kind !== "single_select" || zone.optionsSource.kind !== "lookup")
		throw new Error(
			"The visit form needs a zone question backed by its table.",
		);
	return [
		{
			kind: "updateField",
			uuid: zone.uuid,
			targetKind: "single_select",
			patch: {
				optionsSource: {
					...zone.optionsSource,
					labelColumnId: zone.optionsSource.valueColumnId,
				},
			},
		},
	];
}
