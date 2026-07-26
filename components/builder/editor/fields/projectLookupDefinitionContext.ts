import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type {
	LookupDefinitionsSnapshot,
	LookupTableManifestEntry,
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
	readonly currentProjectId: string | undefined;
	readonly manifestProjectId: string | undefined;
	readonly focusedTableId: LookupTableId | undefined;
	readonly manifestEntry: LookupTableManifestEntry | undefined;
	readonly snapshot: LookupDefinitionsSnapshot | undefined;
}): LookupValidationContext {
	const {
		currentProjectId,
		manifestProjectId,
		focusedTableId,
		manifestEntry,
		snapshot,
	} = args;
	const definition = snapshot?.definitions.find(
		(candidate) => candidate.id === focusedTableId,
	);
	if (
		currentProjectId === undefined ||
		manifestProjectId === undefined ||
		focusedTableId === undefined ||
		manifestEntry === undefined ||
		snapshot === undefined ||
		definition === undefined ||
		currentProjectId !== manifestProjectId ||
		currentProjectId !== snapshot.projectId ||
		manifestEntry.id !== focusedTableId ||
		definition.id !== focusedTableId ||
		manifestEntry.definitionRevision !== definition.definitionRevision
	) {
		return LOOKUP_CONTEXT_UNAVAILABLE;
	}

	return {
		kind: "available",
		projectId: currentProjectId,
		projectRevision: snapshot.projectRevision,
		definitions: [definition],
	};
}
