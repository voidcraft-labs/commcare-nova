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
import type { SiblingLookupMapping } from "./store";
import type { DeploymentResource, DeploymentResourceOwnership } from "./types";

/** One lookup table as the target reports it. */
export interface RemoteLookupTable {
	readonly id: string;
	readonly tag: string;
	/** False when the table's rows go only to the workers who own them. */
	readonly isGlobal: boolean;
	/** Each field's property names, keyed by field name. */
	readonly fieldProperties: Readonly<Record<string, readonly string[]>>;
	/** The row attributes the table's definition names. */
	readonly itemAttributes: readonly string[];
}

/**
 * What HQ's copy of a table holds that Nova's push would remove.
 *
 * The workbook writes every table global, with no field property and no
 * row attribute, and the push replaces the table it names, so a push over
 * any of these takes it away. "not-global" covers every table whose row
 * owners take effect: HQ's restore sends a table that is not global only
 * to the workers who own its rows
 * (`fixtures/fixturegenerators.py::ItemListsProvider.__call__`), and owners
 * on a global table have no effect.
 */
export type UnsupportedLookupContent =
	| "field-properties"
	| "row-attributes"
	| "not-global";

/**
 * In this order: "field-properties" when any field has a property,
 * "row-attributes" when `itemAttributes` is not empty, "not-global" when
 * `isGlobal` is false. Empty when the push keeps everything the definition
 * read shows.
 */
export function unsupportedLookupContent(
	table: RemoteLookupTable,
): readonly UnsupportedLookupContent[] {
	const holds: UnsupportedLookupContent[] = [];
	if (
		Object.values(table.fieldProperties).some(
			(properties) => properties.length > 0,
		)
	)
		holds.push("field-properties");
	if (table.itemAttributes.length > 0) holds.push("row-attributes");
	if (!table.isGlobal) holds.push("not-global");
	return holds;
}

const UNSUPPORTED_LOOKUP_CONTENT_WORDS: Readonly<
	Record<UnsupportedLookupContent, string>
> = {
	"field-properties": "field properties",
	"row-attributes": "row attributes",
	"not-global": "rows limited to certain users",
};

/**
 * What a table holds, in words, joined as "A", "A and B" or "A, B and C":
 * "field properties and rows limited to certain users".
 */
export function describeUnsupportedLookupContent(
	holds: readonly UnsupportedLookupContent[],
): string {
	const words = holds.map((held) => UNSUPPORTED_LOOKUP_CONTENT_WORDS[held]);
	const last = words.at(-1) ?? "";
	return words.length <= 1
		? last
		: `${words.slice(0, -1).join(", ")} and ${last}`;
}

/** A planned table whose tag HQ holds with content the push would remove. */
export interface LookupTableUnsupported {
	readonly tableId: LookupTableId;
	readonly tag: string;
	/** CommCare HQ's id for the table under the tag. */
	readonly remoteId: string;
	/** Never empty. */
	readonly holds: readonly UnsupportedLookupContent[];
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
	/**
	 * The HQ table this deployment's live mapping holds under this tag, which
	 * the drift check compares with its baseline: the table the push writes
	 * over, or the one HQ deleted or renamed since. Null for a table nobody
	 * mapped under this tag, and for one this push adopts, where taking it
	 * over is the person's decision to write over it.
	 */
	readonly mappedRemoteId: string | null;
	/**
	 * Who handed the table to Nova and when, where the push inherits that
	 * standing: the earliest adopted sibling's pair, or the takeover's. Null
	 * where this push's own mapping carries it, where Nova makes the table,
	 * and where this push adopts it, which the person pressing records.
	 */
	readonly adoption: { readonly at: string; readonly by: string } | null;
	/**
	 * What the drift check compares the table with: the stored baseline of
	 * the HQ table a mapping names (`mapping`), the table's own record of
	 * CommCare HQ's table at its last refresh (`table-origin`, for a table a
	 * person took over with Manage in Nova), or nothing.
	 */
	readonly baseline: "mapping" | "table-origin" | null;
}

export type LookupResourcePlan =
	| { readonly ok: true; readonly pushes: readonly PlannedLookupPush[] }
	| { readonly ok: false; readonly conflicts: readonly LookupTableConflict[] }
	| {
			readonly ok: false;
			readonly unsupported: readonly LookupTableUnsupported[];
	  };

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
	/** Live mappings of the Project's other apps for these tables on this project space. */
	readonly siblings: readonly SiblingLookupMapping[];
	/** Tables a person took over from this project space with Manage in Nova. */
	readonly takenOver: readonly {
		readonly tableId: string;
		readonly remoteId: string;
		readonly at: string;
		readonly by: string;
	}[];
}

/**
 * Plan the push, or refuse it.
 *
 * The refusal is all-or-nothing on purpose: the workbook is one upload, so
 * a plan that pushed the unambiguous tables and skipped the rest would
 * leave the project space holding an app's data half-updated with no state
 * that describes it.
 *
 * A tag HQ holds with content the push would remove refuses first, whoever
 * owns the table: adopting cannot keep that content, and the one way out,
 * a new export tag, settles a name clash on the same table too, so asking
 * for an adoption first would only lead here.
 *
 * For a table whose tag CommCare HQ holds, the first arm that matches
 * decides: this deployment's own mapping of that very table; a mapping of
 * the Project's other apps of that very table, whose standing the push
 * inherits (adopted where any of them adopted it, with the earliest
 * adoption's pair); a person's takeover of the table with Manage in Nova,
 * compared with the table's own record of CommCare HQ's table; the caller's
 * explicit adoption; or a conflict. A tag CommCare HQ does not hold is
 * created.
 */
export function planLookupResourcePush(
	input: PlanLookupResourcePushInput,
): LookupResourcePlan {
	const remoteByTag = new Map(
		input.hqTables.map((table) => [table.tag, table] as const),
	);

	const unsupported = input.tables.flatMap(
		(table): LookupTableUnsupported[] => {
			const remote = remoteByTag.get(table.tag);
			if (remote === undefined) return [];
			const holds = unsupportedLookupContent(remote);
			return holds.length === 0
				? []
				: [
						{
							tableId: table.tableId,
							tag: table.tag,
							remoteId: remote.id,
							holds,
						},
					];
		},
	);
	if (unsupported.length > 0) return { ok: false, unsupported };
	const mappingByTableId = new Map(
		input.mappings
			.filter((resource) => resource.kind === "lookup-table")
			.map((resource) => [resource.novaResourceId, resource] as const),
	);
	const takenOverByTableId = new Map(
		input.takenOver.map((taken) => [taken.tableId, taken] as const),
	);
	const adopting = new Set(input.adoptTableIds);

	const pushes: PlannedLookupPush[] = [];
	const conflicts: LookupTableConflict[] = [];

	for (const table of input.tables) {
		const mapping = mappingByTableId.get(table.tableId);
		const remote = remoteByTag.get(table.tag);

		/* Nova already owns the table under this exact name, and the table
		 * on the project space IS the one it owns. An absent table is a NEW
		 * creation, including when the previous object was adopted. Its old
		 * adoption remains in superseded history, never on the new object.
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
			remote !== undefined &&
			remote.id === mapping.remoteId
		) {
			pushes.push({
				tableId: table.tableId,
				tag: table.tag,
				ownership: mapping.ownership,
				mappedRemoteId: mapping.remoteId,
				adoption: null,
				baseline: "mapping",
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
			 * `adopted`. The tag was renamed or its table disappeared, so this
			 * push makes a table on CommCare HQ that did not
			 * exist a moment ago: Nova made it, and inheriting the old claim
			 * would file a table nobody has ever seen as one somebody chose
			 * to take over. The old table keeps its own adopted row, which is
			 * what the left-behind report reads. */
			const mappedRemoteId =
				mapping !== undefined && mapping.pushedIdentity === table.tag
					? mapping.remoteId
					: null;
			pushes.push({
				tableId: table.tableId,
				tag: table.tag,
				ownership: "nova-created",
				mappedRemoteId,
				adoption: null,
				baseline: mappedRemoteId === null ? null : "mapping",
			});
			continue;
		}

		/* Another app of the Project accounts for the very table CommCare HQ
		 * holds under this tag: the standing is the Project's, so this app
		 * pushes it too, and compares with the baseline that app's push
		 * wrote, which is keyed by the HQ table. A sibling whose mapping
		 * names another id describes a table CommCare HQ has since made
		 * again, and says nothing. */
		const accounting = input.siblings.filter(
			(sibling) =>
				sibling.tableId === table.tableId &&
				sibling.pushedIdentity === table.tag &&
				sibling.remoteId === remote.id,
		);
		if (accounting.length > 0) {
			const adoption = earliestAdoption(accounting);
			pushes.push({
				tableId: table.tableId,
				tag: table.tag,
				ownership: adoption === null ? "nova-created" : "adopted",
				mappedRemoteId: remote.id,
				adoption,
				baseline: "mapping",
			});
			continue;
		}

		/* A person took the table over from this project space with Manage in
		 * Nova. That is the recorded decision to publish Nova's copy over it,
		 * attributed to them; the drift check compares CommCare HQ now with
		 * the table's record of it at the last refresh, by content, so an id
		 * CommCare HQ minted again since is no reason to stop. */
		const taken = takenOverByTableId.get(table.tableId);
		if (taken !== undefined) {
			pushes.push({
				tableId: table.tableId,
				tag: table.tag,
				ownership: "adopted",
				mappedRemoteId: remote.id,
				adoption: { at: taken.at, by: taken.by },
				baseline: "table-origin",
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
			mappedRemoteId: null,
			adoption: null,
			baseline: null,
		});
	}

	if (conflicts.length > 0) return { ok: false, conflicts };
	return { ok: true, pushes };
}

/**
 * The earliest adoption among sibling mappings of one table, or null where
 * none of them adopted it. Ties on the moment go to the first listed, which
 * `readSiblingLookupMappings` orders by mapping age.
 */
function earliestAdoption(
	siblings: readonly SiblingLookupMapping[],
): { readonly at: string; readonly by: string } | null {
	let earliest: { readonly at: string; readonly by: string } | null = null;
	for (const sibling of siblings) {
		if (sibling.ownership !== "adopted") continue;
		if (sibling.adoptedAt === null || sibling.adoptedBy === null) {
			throw new Error(
				"An adopted lookup table mapping holds no adoption pair, which its CHECK rules out.",
			);
		}
		if (
			earliest === null ||
			Date.parse(sibling.adoptedAt) < Date.parse(earliest.at)
		) {
			earliest = { at: sibling.adoptedAt, by: sibling.adoptedBy };
		}
	}
	return earliest;
}
