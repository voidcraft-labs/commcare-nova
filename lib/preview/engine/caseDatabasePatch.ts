import type { CaseDatabaseSnapshot } from "./xpathInstances";

/** A submission changes the local device database before the next sync.
 * Keep just-closed or reassigned rows for form links, and replace all edges
 * from affected cases with the transaction's exact post-write edges. */
export function overlayCaseDatabasePatch(
	entry: CaseDatabaseSnapshot,
	patch: CaseDatabaseSnapshot,
): CaseDatabaseSnapshot {
	const affected = new Map(patch.rows.map((row) => [row.case_id, row]));
	const existing = new Set(entry.rows.map((row) => row.case_id));
	return {
		rows: [
			...entry.rows.map((row) => affected.get(row.case_id) ?? row),
			...patch.rows.filter((row) => !existing.has(row.case_id)),
		],
		indices: [
			...entry.indices.filter((index) => !affected.has(index.case_id)),
			...patch.indices,
		],
		...(entry.propertyTypes !== undefined || patch.propertyTypes !== undefined
			? { propertyTypes: { ...entry.propertyTypes, ...patch.propertyTypes } }
			: {}),
	};
}
