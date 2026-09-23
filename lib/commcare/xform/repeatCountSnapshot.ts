import { RESERVED_XFORM_NODE_PREFIX } from "../constants";

/** Count targets are siblings within a repeat and root children otherwise. */
export function repeatCountSnapshotName(
	fieldId: string,
	existingNames: ReadonlySet<string>,
): string {
	const base = `${RESERVED_XFORM_NODE_PREFIX}count_${fieldId}`;
	let name = base;
	for (let n = 1; existingNames.has(name); n++) name = `${base}_${n}`;
	return name;
}
