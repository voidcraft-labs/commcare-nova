import { USERCASE_CASE_TYPE } from "@/lib/domain";
import { caseRowToFormPreload } from "./caseDataBindingClient";
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

/** Case UUID and worker UUID are different identities. Match the same semantic
 * key used to materialize the worker record, never an arbitrary usercase. */
export function submissionWorkerValues(
	patch: CaseDatabaseSnapshot,
	workerId: string | undefined,
	previous: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	const row =
		workerId === undefined
			? undefined
			: patch.rows.find(
					(row) =>
						row.case_type === USERCASE_CASE_TYPE &&
						row.properties.hq_user_id === workerId,
				);
	return row
		? { ...previous, ...Object.fromEntries(caseRowToFormPreload(row)) }
		: previous;
}
