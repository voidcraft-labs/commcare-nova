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

import { readLookupActivationFlags } from "@/lib/db/rolloutCompatibility";
import type { LookupActivationState } from "@/lib/doc/lookupReferences";
import "server-only";

import {
	buildLookupFixtures,
	type CompiledLookupFixtureSet,
	lookupFixtureBudgetExcess,
	type PreparedLookupWire,
} from "@/lib/commcare/lookup/fixtures";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { lookupSelectSourceRowFindings } from "@/lib/commcare/lookup/selectSourceRows";
import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import { evaluateBoundary } from "@/lib/commcare/validator/gate";
import type { ProjectAccess } from "@/lib/db/appAccess";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import { collectDormantLookupCarriers } from "@/lib/doc/dormantLookupCarriers";
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
import {
	getLookupDefinitions,
	getLookupFixtureData,
} from "@/lib/lookup/service";
import type {
	LookupDefinitionsSnapshot,
	LookupFixtureDataSnapshot,
} from "@/lib/lookup/types";
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
	/**
	 * Identity naming plus budget-checked fixture blocks, built from the same
	 * snapshot generation the validator saw. Present exactly on `ccz` — the
	 * one mode that embeds lookup data — and absent when the doc references
	 * no table.
	 */
	readonly lookupWire?: PreparedLookupWire;
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
	mode?: ExportMode,
	lookupRows?: LookupRowVerdictInput,
	activation?: LookupActivationState,
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
			...lookupExportFindings(doc, mode, lookupRows),
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
		activation,
	);
	const budgetError = exportBudgetError(rows);
	return [
		...errors,
		...lookupExportFindings(doc, mode, lookupRows),
		...(budgetError === null ? [] : [budgetError]),
	];
}

/** Row snapshot plus the pre-built fixture set for the ccz row verdicts. */
interface LookupRowVerdictInput {
	readonly fixtureData: LookupFixtureDataSnapshot;
	readonly fixtures: CompiledLookupFixtureSet;
}

/**
 * The mode's complete lookup verdict. `ccz` embeds lookup data, so it swaps
 * the dormant-carrier rejection for the row-dependent checks a definitions
 * snapshot cannot prove: select-source option validity over complete tables
 * and the aggregate embedded-fixture budget. `hq-json` and `hq-upload` keep
 * rejecting every carrier until S20 pushes and maps the resources.
 */
function lookupExportFindings(
	doc: BlueprintDoc,
	mode: ExportMode | undefined,
	lookupRows: LookupRowVerdictInput | undefined,
): ValidationError[] {
	if (mode === undefined) return [];
	if (mode !== "ccz") return dormantLookupCarrierExportFindings(doc, mode);
	if (lookupRows === undefined) return [];
	return [
		...lookupSelectSourceRowFindings(doc, lookupRows.fixtureData),
		...lookupFixtureBudgetFindings(lookupRows.fixtures),
	];
}

const BUDGET_AXIS_LABELS = {
	rows: "rows",
	cells: "cells",
	bytes: "bytes of fixture data",
} as const;

function lookupFixtureBudgetFindings(
	fixtures: CompiledLookupFixtureSet,
): ValidationError[] {
	const excess = lookupFixtureBudgetExcess(fixtures);
	if (excess === null) return [];
	const axisSummaries = excess.map(
		(axis) =>
			`${axis.actual.toLocaleString("en-US")} ${BUDGET_AXIS_LABELS[axis.axis]} (the limit is ${axis.allowed.toLocaleString("en-US")})`,
	);
	const largestTags = [
		...new Set(
			excess.flatMap((axis) => axis.largestTables.map((table) => table.tag)),
		),
	];
	return [
		validationError(
			"LOOKUP_FIXTURE_EXPORT_TOO_LARGE",
			"app",
			`This app references more lookup data than a downloadable app can bundle — ${axisSummaries.join(
				" and ",
			)}. The largest tables are ${largestTags.join(
				", ",
			)}; shrink or split them, or remove some lookup references, then export again.`,
			{},
			Object.fromEntries(
				excess.flatMap((axis) => [
					[`${axis.axis}Actual`, String(axis.actual)],
					[`${axis.axis}Allowed`, String(axis.allowed)],
					[
						`${axis.axis}LargestTables`,
						axis.largestTables
							.map((table) => `${table.tag}:${table.amount}`)
							.join(","),
					],
				]),
			),
		),
	];
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
	const scope = {
		projectId: input.access.projectId,
		actorId: input.access.actorUserId,
		role: input.access.role,
	};

	/* Always read, including `[]`. Besides definitions, the read captures the
	 * Project revision that identifies this exact snapshot. The service uses
	 * one read-only REPEATABLE READ transaction. On `ccz` — the one mode that
	 * embeds lookup data — the same snapshot also carries every referenced
	 * table's complete ordered rows, so validation, the row-dependent
	 * verdicts, and emission all consume one generation. Any operational
	 * failure intentionally throws through this function; it is not a document
	 * finding and must stop the export rather than masquerade as unavailable
	 * context. */
	const fixtureData =
		input.mode === "ccz"
			? await getLookupFixtureData(scope, lookupTargets.tableIds)
			: undefined;
	const lookupSnapshot: LookupDefinitionsSnapshot =
		fixtureData ?? (await getLookupDefinitions(scope, lookupTargets.tableIds));
	if (lookupSnapshot.projectId !== input.access.projectId) {
		throw new Error(
			"Lookup definition reader returned a snapshot for the wrong Project.",
		);
	}
	const lookupContext = availableLookupContext(lookupSnapshot);

	/* Fixture blocks are built before the verdict so the aggregate budget
	 * measures the exact serialized bytes the compiler would embed; the
	 * elements are reused on success rather than rebuilt. */
	const lookupWire =
		fixtureData === undefined || lookupTargets.tableIds.length === 0
			? undefined
			: (() => {
					const naming = lookupWireNaming(fixtureData.definitions);
					return {
						naming,
						fixtures: buildLookupFixtures(naming, fixtureData.rowsByTable),
					};
				})();

	/* This subordinate loader evaluates the complete document gate with both
	 * the exact lookup context and the Project-filtered media rows. It returns
	 * findings only; operational media reads continue to throw. The activation
	 * flags condition the dormant-vocabulary gates: once operations/carriers
	 * are admitted, a ccz export of a doc carrying them passes (the hq modes'
	 * carrier rejection below stays unconditional until S20). */
	const activation = await readLookupActivationFlags();
	const violations = await collectViolationsWithRegistry(
		input.doc,
		input.access.projectId,
		lookupContext,
		registry,
		input.mode,
		fixtureData === undefined || lookupWire === undefined
			? undefined
			: { fixtureData, fixtures: lookupWire.fixtures },
		activation,
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
			...(lookupWire !== undefined && { lookupWire }),
		},
	};
}

const EXPORT_MODE_LABELS: Readonly<Record<ExportMode, string>> = {
	ccz: "a downloadable app",
	"hq-json": "an HQ import file",
	"hq-upload": "a direct HQ upload",
};

/**
 * The HQ export targets stay closed while lookup resources cannot be pushed
 * or mapped; `ccz` embeds its fixtures locally and no longer takes this
 * finding. The selected Nova export intent is part of both the finding
 * details and identity so the boundary never silently collapses three
 * distinct decisions.
 */
function dormantLookupCarrierExportFindings(
	doc: BlueprintDoc,
	mode: ExportMode,
): ValidationError[] {
	return collectDormantLookupCarriers(doc).map((carrier) =>
		validationError(
			"LOOKUP_CARRIER_EXPORT_NOT_ACTIVE",
			carrier.location.scope,
			`Lookup-powered choices and calculations cannot be exported as ${EXPORT_MODE_LABELS[mode]} yet. Remove the lookup-powered setting before exporting.`,
			carrier.location,
			{
				exportMode: mode,
				carrierOwnerUuid: carrier.ownerUuid,
				carrierOwnerKind: carrier.ownerKind,
				carrierSlot: carrier.slot,
				carrierSubpath: carrier.subpath,
				carrierFingerprint: carrier.fingerprint,
			},
		),
	);
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
