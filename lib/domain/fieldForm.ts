// lib/domain/fieldForm.ts
import type { BlueprintDoc } from "./blueprint";
import type { FieldKind } from "./fields";
import type { Uuid } from "./uuid";

/** The form a field belongs to, walking `fieldParent` to the root; a form's
 *  own uuid names itself. Undefined for a field no form holds. */
export function formOfField(
	doc: Pick<BlueprintDoc, "forms" | "fieldParent">,
	fieldUuid: Uuid,
): Uuid | undefined {
	let cursor: Uuid | undefined = fieldUuid;
	const seen = new Set<Uuid>();
	while (cursor !== undefined && !seen.has(cursor)) {
		seen.add(cursor);
		if (Object.hasOwn(doc.forms, cursor)) return cursor;
		cursor = doc.fieldParent[cursor];
	}
	return undefined;
}

/** A hidden value and a submitted Connect activity have no worker control. */
export function fieldHasWorkerControl(
	kind: FieldKind,
): kind is Exclude<FieldKind, "hidden" | "connect_activity"> {
	return kind !== "hidden" && kind !== "connect_activity";
}

/** A Connect activity may sit before the worker's first page. */
export function formIsSectioned(
	doc: Pick<BlueprintDoc, "fieldOrder" | "fields">,
	formUuid: Uuid,
): boolean {
	return (
		doc.fieldOrder[formUuid]?.some(
			(uuid) => doc.fields[uuid]?.kind === "section",
		) ?? false
	);
}
