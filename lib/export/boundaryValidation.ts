/**
 * The Nova export boundary shared by every artifact and HQ-upload surface.
 *
 * Export intent is expressed with three Nova-owned modes. The mode is carried
 * through the prepared value so later lookup-resource emitters can make one
 * explicit target decision without re-reading definitions:
 *
 * - `ccz` — the locally installable archive;
 * - `hq-json` — the manual HQ-import artifact;
 * - `hq-upload` — the direct HQ upload flow.
 *
 * This module is server-only and deliberately sits outside `lib/commcare`:
 * callers authorize and hydrate a Nova `BlueprintDoc`, then this boundary
 * loads every external validation resource before any wire emitter runs.
 */

import "server-only";

import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import { evaluateBoundary } from "@/lib/commcare/validator/gate";
import type { ProjectAccess } from "@/lib/db/appAccess";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	extractLookupReferenceTargets,
	type LookupReferenceExtractorRegistry,
	type LookupReferenceTargetSet,
	type LookupValidationContext,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import { MAX_MEDIA_EXPORT_ASSETS } from "@/lib/domain/multimedia";
import { getLookupDefinitions } from "@/lib/lookup/service";
import type { LookupDefinitionsSnapshot } from "@/lib/lookup/types";
import {
	builtinAssetRows,
	partitionAssetRefs,
} from "@/lib/media/builtinIconAssets";
import { exportBudgetExcess } from "@/lib/media/exportBudget";
import { resolveMediaManifest } from "@/lib/media/manifest";

export const EXPORT_MODES = ["ccz", "hq-json", "hq-upload"] as const;
export type ExportMode = (typeof EXPORT_MODES)[number];

export type AvailableLookupValidationContext = Extract<
	LookupValidationContext,
	{ readonly kind: "available" }
>;

export interface PrepareExportBoundaryInput {
	readonly mode: ExportMode;
	/** Authorized Project identity and role from the app access gate. */
	readonly access: ProjectAccess;
	/** Hydrated blueprint from the same app load as `compiledAtSeq`. */
	readonly doc: BlueprintDoc;
	readonly compiledAtSeq: number;
}

/**
 * The exact external-resource generation validated for one export.
 *
 * `lookupSnapshot.definitions` and `lookupContext.definitions` are the same
 * array object. Future emitters consume this value directly; a second lookup
 * read after validation would create a generation-skew race and is forbidden.
 */
export interface PreparedExportBoundary {
	readonly mode: ExportMode;
	readonly doc: BlueprintDoc;
	readonly compiledAtSeq: number;
	readonly assets: Awaited<ReturnType<typeof resolveMediaManifest>>;
	readonly lookupTargets: LookupReferenceTargetSet;
	readonly lookupSnapshot: LookupDefinitionsSnapshot;
	readonly lookupContext: AvailableLookupValidationContext;
}

export type PrepareExportBoundaryResult =
	| { readonly ok: true; readonly prepared: PreparedExportBoundary }
	| { readonly ok: false; readonly violations: readonly ValidationError[] };

/** Build the available validator context without cloning its exact snapshot. */
function availableLookupContext(
	snapshot: LookupDefinitionsSnapshot,
): AvailableLookupValidationContext {
	return {
		kind: "available",
		projectId: snapshot.projectId,
		projectRevision: snapshot.projectRevision,
		definitions: snapshot.definitions,
	};
}

/**
 * Load the Project-filtered media rows and run the sole complete export
 * evaluator. Export preparation calls this only after obtaining its exact
 * lookup context; the focused exported wrapper below fixes this to the
 * production registry for legacy media-rule coverage.
 */
async function collectViolationsWithRegistry(
	doc: BlueprintDoc,
	projectId: string,
	lookupContext: LookupValidationContext,
	lookupReferenceExtractors: LookupReferenceExtractorRegistry,
): Promise<ValidationError[]> {
	const ids = [...collectAssetRefs(doc)];
	const { realIds, builtinSlugs } = partitionAssetRefs(ids);

	/* Bound the metadata read itself. The doc schema does not cap distinct
	 * references, so waiting until after rows load would leave an unbounded
	 * allocation ahead of the aggregate budget verdict. */
	const exportableRefCount = realIds.length + builtinSlugs.length;
	if (exportableRefCount > MAX_MEDIA_EXPORT_ASSETS) {
		return [
			validationError(
				"MEDIA_EXPORT_TOO_LARGE",
				"app",
				`This app references too many attachments to export — ${exportableRefCount} (the limit is ${MAX_MEDIA_EXPORT_ASSETS}). Remove some attachments, then export again.`,
				{},
			),
		];
	}

	const realRows =
		realIds.length === 0 ? [] : await loadAssetsByIds(realIds, projectId);
	const rows = [...realRows, ...builtinAssetRows(builtinSlugs)];
	const mediaAssets = new Map(rows.map((row) => [row.id as string, row]));
	const errors = evaluateBoundary(
		doc,
		mediaAssets,
		lookupContext,
		lookupReferenceExtractors,
	);
	const budgetError = exportBudgetError(rows);
	return budgetError ? [...errors, budgetError] : errors;
}

/**
 * Focused production-registry evaluator for the existing media boundary tests.
 * Real export entry points call {@link prepareExportBoundary} instead.
 */
export function collectExportBoundaryViolations(
	doc: BlueprintDoc,
	projectId: string,
	lookupContext: LookupValidationContext,
): Promise<ValidationError[]> {
	return collectViolationsWithRegistry(
		doc,
		projectId,
		lookupContext,
		PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
	);
}

function exportBudgetError(rows: MediaAssetRecord[]): ValidationError | null {
	const excess = exportBudgetExcess(rows);
	if (excess === null) return null;
	return validationError(
		"MEDIA_EXPORT_TOO_LARGE",
		"app",
		`This app bundles too much media to export — ${excess.reasons.join(
			" and ",
		)}. Remove or shrink some attachments, then export again.`,
		{},
	);
}

async function prepareWithRegistry(
	input: PrepareExportBoundaryInput,
	registry: LookupReferenceExtractorRegistry,
): Promise<PrepareExportBoundaryResult> {
	const lookupTargets = extractLookupReferenceTargets(input.doc, registry);

	/* Always read, including `[]`. Besides definitions, the read captures the
	 * Project revision that identifies this exact rows-free snapshot. The
	 * service uses one read-only REPEATABLE READ transaction. Any operational
	 * failure intentionally throws through this function; it is not a document
	 * finding and must stop the export rather than masquerade as unavailable
	 * context. */
	const lookupSnapshot = await getLookupDefinitions(
		{
			projectId: input.access.projectId,
			actorId: input.access.actorUserId,
			role: input.access.role,
		},
		lookupTargets.tableIds,
	);
	if (lookupSnapshot.projectId !== input.access.projectId) {
		throw new Error(
			"Lookup definition reader returned a snapshot for the wrong Project.",
		);
	}
	const lookupContext = availableLookupContext(lookupSnapshot);

	/* This subordinate loader evaluates the complete document gate with both
	 * the exact lookup context and the Project-filtered media rows. It returns
	 * findings only; operational media reads continue to throw. */
	const violations = await collectViolationsWithRegistry(
		input.doc,
		input.access.projectId,
		lookupContext,
		registry,
	);
	if (violations.length > 0) {
		return { ok: false, violations };
	}

	/* Bytes are resolved only after the complete boundary succeeds. All three
	 * current targets need bytes: CCZ embeds them, HQ JSON ships its sidecar
	 * bundle, and HQ upload sends its media bundle after import. */
	const assets = await resolveMediaManifest(input.doc, input.access.projectId, {
		withBytes: true,
	});

	return {
		ok: true,
		prepared: {
			mode: input.mode,
			doc: input.doc,
			compiledAtSeq: input.compiledAtSeq,
			assets,
			lookupTargets,
			lookupSnapshot,
			lookupContext,
		},
	};
}

/** Prepare one authoritative export using the immutable production registry. */
export function prepareExportBoundary(
	input: PrepareExportBoundaryInput,
): Promise<PrepareExportBoundaryResult> {
	return prepareWithRegistry(input, PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS);
}

function assertImmutableSyntheticRegistry(
	registry: LookupReferenceExtractorRegistry,
): void {
	if (
		!Object.isFrozen(registry) ||
		registry.some((extractor) => !Object.isFrozen(extractor))
	) {
		throw new Error(
			"Synthetic lookup reference extractor registries and their entries must be frozen.",
		);
	}
}

/**
 * Synthetic-carrier seam for S02 races and boundary tests. Production export
 * entry points must use {@link prepareExportBoundary}; S05 changes the shared
 * production registry instead of injecting a caller-owned one.
 *
 * @internal
 */
export function prepareExportBoundaryWithRegistry(
	input: PrepareExportBoundaryInput,
	registry: LookupReferenceExtractorRegistry,
): Promise<PrepareExportBoundaryResult> {
	assertImmutableSyntheticRegistry(registry);
	return prepareWithRegistry(input, registry);
}
