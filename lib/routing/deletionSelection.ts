import { flattenFieldRefs } from "@/lib/doc/navigation";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";

/** Select the adjacent visible field after an accepted deletion. The before
 * snapshot supplies visual order; the after snapshot determines which rows
 * still exist after a group or repeat was removed with its descendants. */
export function selectionAfterFieldDeletion(
	before: BlueprintDoc,
	after: BlueprintDoc,
	formUuid: Uuid,
	selectedUuid: Uuid,
): Uuid | undefined {
	const refs = flattenFieldRefs(before, formUuid);
	const index = refs.findIndex((ref) => ref.uuid === selectedUuid);
	if (index < 0) return undefined;
	const survives = (ref: (typeof refs)[number]) =>
		after.fields[ref.uuid] !== undefined;
	return (
		refs.slice(index + 1).find(survives) ??
		refs.slice(0, index).findLast(survives)
	)?.uuid;
}
