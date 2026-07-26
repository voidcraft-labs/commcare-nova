import {
	LOOKUP_CONTEXT_UNAVAILABLE,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type {
	LookupDefinitionsSnapshot,
	LookupRevision,
	LookupTableManifestEntry,
} from "@/lib/lookup/types";

export type ProjectLookupDefinitionReadVerdict =
	| { readonly kind: "available" }
	| { readonly kind: "deleted" }
	| { readonly kind: "loading" }
	| { readonly kind: "retry" };

/**
 * Interpret the two independently-read resources before a picker renders.
 *
 * Equal Project generations make absence meaningful: both reads omitted the
 * table, so it is gone. Different generations are neither loading forever nor
 * permission to call it deleted — they are an explicit Retry state.
 */
export function projectLookupDefinitionReadVerdict(args: {
	readonly currentProjectId: string | undefined;
	readonly manifestProjectId: string | undefined;
	readonly focusedTableId: LookupTableId | undefined;
	readonly manifestProjectRevision: LookupRevision | undefined;
	readonly snapshot: LookupDefinitionsSnapshot | undefined;
	readonly manifestEntry: LookupTableManifestEntry | undefined;
}): ProjectLookupDefinitionReadVerdict {
	if (args.focusedTableId === undefined) return { kind: "available" };
	if (
		args.manifestProjectRevision === undefined ||
		args.snapshot === undefined
	) {
		return { kind: "loading" };
	}
	if (
		args.currentProjectId === undefined ||
		args.manifestProjectId !== args.currentProjectId ||
		args.snapshot.projectId !== args.currentProjectId
	) {
		return { kind: "retry" };
	}
	if (args.manifestProjectRevision !== args.snapshot.projectRevision) {
		return { kind: "retry" };
	}
	const definition = args.snapshot.definitions.find(
		(candidate) => candidate.id === args.focusedTableId,
	);
	if (args.manifestEntry === undefined && definition === undefined) {
		return { kind: "deleted" };
	}
	if (
		args.manifestEntry === undefined ||
		definition === undefined ||
		args.manifestEntry.definitionRevision !== definition.definitionRevision
	) {
		return { kind: "retry" };
	}
	return { kind: "available" };
}

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
	readonly manifestProjectRevision: LookupRevision | undefined;
	readonly focusedTableId: LookupTableId | undefined;
	readonly manifestEntry: LookupTableManifestEntry | undefined;
	readonly snapshot: LookupDefinitionsSnapshot | undefined;
}): LookupValidationContext {
	const {
		currentProjectId,
		manifestProjectId,
		manifestProjectRevision,
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
		manifestProjectRevision !== snapshot.projectRevision ||
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
