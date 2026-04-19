import type { Field } from "@/lib/domain";

/**
 * Depth-first lookup of a field by its semantic `id` starting from a given
 * parent uuid in the normalized doc. Recurses into `group` / `repeat`
 * containers so nested fields are reachable through a single call.
 *
 * The close-condition UI uses this to locate a referenced field's option
 * list without round-tripping through any legacy assembled-questions shape.
 */
export function findFieldById(
	fields: Readonly<Record<string, Field>>,
	fieldOrder: Readonly<Record<string, readonly string[]>>,
	parentUuid: string,
	id: string,
): Field | undefined {
	const childUuids = fieldOrder[parentUuid] ?? [];
	for (const uuid of childUuids) {
		const field = fields[uuid];
		if (!field) continue;
		if (field.id === id) return field;
		if (field.kind === "group" || field.kind === "repeat") {
			const found = findFieldById(fields, fieldOrder, uuid, id);
			if (found) return found;
		}
	}
	return undefined;
}
