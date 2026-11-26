import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, proseText } from "@/lib/domain";

/** A label edit in the form that uses the indexed village lookup. */
export function edit(doc: BlueprintDoc): readonly Mutation[] {
	const [menu] = doc.moduleOrder;
	const [form] = menu ? (doc.formOrder[menu] ?? []) : [];
	const farmerName = form
		? doc.fieldOrder[form]?.find(
				(uuid) => doc.fields[uuid]?.id === "farmer_name",
			)
		: undefined;
	if (!farmerName)
		throw new Error("The HQ lookup survey has no farmer name question.");
	return [
		{
			kind: "updateField",
			uuid: farmerName,
			targetKind: "text",
			patch: { label: proseText("Full name of the farmer") },
		},
	];
}
