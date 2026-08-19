/**
 * Which of an app's lookup tables Nova may put on a project space, and
 * under what claim.
 *
 * CommCare HQ's fixture upload matches tables BY TAG
 * (`fixtures/upload/run_upload.py::table_key`), so a workbook naming
 * `districts` silently becomes whatever `districts` already means on that
 * project space. That is the auto-adoption the deployment contract
 * forbids: two project spaces can hold two unrelated tables sharing a
 * name, and taking one over on a name match attaches an app to somebody
 * else's data. So the push is planned against the ownership ledger first,
 * and a name Nova cannot account for stops it.
 *
 * Everything here is pure. The read that supplies `hqTables` is the
 * caller's, and its FAILURE is the caller's too — a plan built from "no
 * tables came back" would read an unanswerable question as permission.
 */

import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { DeploymentResource, DeploymentResourceOwnership } from "./types";

/** One lookup table as the target reports it. */
export interface RemoteLookupTable {
	readonly id: string;
	readonly tag: string;
}

/** One of Nova's tables, as the workbook will present it. */
export interface PlannedLookupTable {
	readonly tableId: LookupTableId;
	readonly tag: string;
}

/**
 * A tag the target already uses for a table Nova cannot account for.
 *
 * The tag is what a person will see in CommCare HQ's own lookup-table
 * list, and the remote id is what identifies the table there. The
 * author's own name for the Nova table is joined on later, by the caller
 * that holds the definitions.
 */
export interface LookupTableConflict {
	readonly tableId: LookupTableId;
	readonly tag: string;
	/** CommCare HQ's id for the table already there. */
	readonly remoteId: string;
}

/** One table's place in the push. */
export interface PlannedLookupPush {
	readonly tableId: LookupTableId;
	readonly tag: string;
	readonly ownership: DeploymentResourceOwnership;
}

export type LookupResourcePlan =
	| { readonly ok: true; readonly pushes: readonly PlannedLookupPush[] }
	| { readonly ok: false; readonly conflicts: readonly LookupTableConflict[] };

export interface PlanLookupResourcePushInput {
	/** Every table the app references, from the validated generation. */
	readonly tables: readonly PlannedLookupTable[];
	/** The deployment's live mappings — every kind; this filters its own. */
	readonly mappings: readonly DeploymentResource[];
	/** What the target holds right now. Never a guess, never a default. */
	readonly hqTables: readonly RemoteLookupTable[];
	/**
	 * The Nova table ids whose conflicts the caller has explicitly resolved
	 * by taking the existing table over. Nothing is adopted that is not
	 * named here, and naming a table that is not in conflict changes
	 * nothing — the plan still records the ownership it can actually prove.
	 */
	readonly adoptTableIds: readonly string[];
}

/**
 * Plan the push, or refuse it.
 *
 * The refusal is all-or-nothing on purpose: the workbook is one upload, so
 * a plan that pushed the unambiguous tables and skipped the rest would
 * leave the project space holding an app's data half-updated with no state
 * that describes it.
 */
export function planLookupResourcePush(
	input: PlanLookupResourcePushInput,
): LookupResourcePlan {
	const remoteByTag = new Map(
		input.hqTables.map((table) => [table.tag, table] as const),
	);
	const mappingByTableId = new Map(
		input.mappings
			.filter((resource) => resource.kind === "lookup-table")
			.map((resource) => [resource.novaResourceId, resource] as const),
	);
	const adopting = new Set(input.adoptTableIds);

	const pushes: PlannedLookupPush[] = [];
	const conflicts: LookupTableConflict[] = [];

	for (const table of input.tables) {
		const mapping = mappingByTableId.get(table.tableId);
		const remote = remoteByTag.get(table.tag);

		/* Nova already owns the table under this exact name, and the table
		 * on the project space IS the one it owns. Gone from CommCare HQ
		 * counts too: the push is the same act, the upload creates what is
		 * missing, and the claim is the one already recorded.
		 *
		 * The id comparison is not belt-and-braces. A table Nova pushed can
		 * be deleted on CommCare HQ and a DIFFERENT one made under the same
		 * tag, and the ledger cannot tell the two apart by name — which is
		 * the whole reason this planner exists. So a mapping whose remote id
		 * no longer matches falls through to the same explicit decision a
		 * stranger's table gets. */
		if (
			mapping !== undefined &&
			mapping.pushedIdentity === table.tag &&
			(remote === undefined || remote.id === mapping.remoteId)
		) {
			pushes.push({
				tableId: table.tableId,
				tag: table.tag,
				ownership: mapping.ownership,
			});
			continue;
		}

		/* Nothing of that name is there, so the push creates it and the
		 * claim is unambiguous. A mapping under a DIFFERENT name means the
		 * tag was renamed in Nova: the push makes a new table, the ledger
		 * supersedes the old row, and the old table stays where it is and
		 * is reported from that superseded row's own `pushedIdentity` --
		 * deleting a remote resource on a rename is exactly what the
		 * deployment contract forbids. */
		if (remote === undefined) {
			/* Always `nova-created`, even when the superseded mapping was
			 * `adopted`. Reaching here with a mapping means the tag was
			 * RENAMED, so this push makes a table on CommCare HQ that did not
			 * exist a moment ago: Nova made it, and inheriting the old claim
			 * would file a table nobody has ever seen as one somebody chose
			 * to take over. The old table keeps its own adopted row, which is
			 * what the left-behind report reads. */
			pushes.push({
				tableId: table.tableId,
				tag: table.tag,
				ownership: "nova-created",
			});
			continue;
		}

		/* Something of that name is there and Nova cannot account for it.
		 * Only an explicit decision resolves this. */
		if (!adopting.has(table.tableId)) {
			conflicts.push({
				tableId: table.tableId,
				tag: table.tag,
				remoteId: remote.id,
			});
			continue;
		}
		pushes.push({
			tableId: table.tableId,
			tag: table.tag,
			ownership: "adopted",
		});
	}

	if (conflicts.length > 0) return { ok: false, conflicts };
	return { ok: true, pushes };
}
