import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type {
	LookupTableManifestEntry,
	LookupTableSnapshot,
} from "@/lib/lookup/types";

/**
 * Turn one focused table read into the optimistic client-gate context.
 *
 * Manifest and table are independent snapshots. The context stays unavailable
 * until they name the same table generation, so a kept-stale table body cannot
 * authorize a gesture after selection or a realtime revision changes. The
 * authoritative writer still repeats validation against fresh Project state.
 */
export function projectLookupDefinitionContext(args: {
	readonly focusedTableId: LookupTableId | undefined;
	readonly manifestEntry: LookupTableManifestEntry | undefined;
	readonly snapshot: LookupTableSnapshot | undefined;
}): LookupValidationContext {
	const { focusedTableId, manifestEntry, snapshot } = args;
	if (
		focusedTableId === undefined ||
		manifestEntry === undefined ||
		snapshot === undefined ||
		manifestEntry.id !== focusedTableId ||
		snapshot.id !== focusedTableId ||
		manifestEntry.tableRevision !== snapshot.tableRevision
	) {
		return LOOKUP_CONTEXT_UNAVAILABLE;
	}

	return {
		kind: "available",
		projectId: snapshot.projectId,
		projectRevision: snapshot.projectRevision,
		definitions: [
			{
				id: snapshot.id,
				name: snapshot.name,
				tag: snapshot.tag,
				definitionRevision: snapshot.definitionRevision,
				columns: snapshot.columns,
			},
		],
	};
}
