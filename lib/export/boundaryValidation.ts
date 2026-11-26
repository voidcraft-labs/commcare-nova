import { ApiError } from "@/lib/apiError";
import { requiresLookupProjection } from "@/lib/lookup/source";
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

import type { PreparedLookupWire } from "@/lib/commcare/lookup/fixtures";
import type {
	LookupTableWireNaming,
	LookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import type { LookupWorkbook } from "@/lib/commcare/lookup/workbook";
import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import { evaluateBoundary } from "@/lib/commcare/validator/gate";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import type { ProjectAccess } from "@/lib/db/appAccess";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { DestinationOwnerAccess } from "@/lib/deployment/destinationRowOwners";
import {
	extractLookupReferenceTargets,
	type LookupReferenceExtractorRegistry,
	type LookupReferenceTargetSet,
	type LookupValidationContext,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	MAX_MEDIA_EXPORT_ASSETS,
	type MediaAssetId,
} from "@/lib/domain/multimedia";
import { getLookupFixtureData } from "@/lib/lookup/service";
import type {
	LookupFixtureDataSnapshot,
	LookupScope,
	LookupTableId,
} from "@/lib/lookup/types";
import {
	builtinAssetRows,
	partitionAssetRefs,
} from "@/lib/media/builtinIconAssets";
import { exportBudgetExcess } from "@/lib/media/exportBudget";
import { resolveMediaManifest } from "@/lib/media/manifest";
import {
	type ExportMode,
	exportCarrierFindings,
	type LookupTarget,
	lookupFixtureBudgetFindings,
	type ManagedLookupTable,
	type ManagedLookupWorkbook,
} from "./boundaryFindings";
import {
	type AssignmentWitness,
	installLookupWitness,
	readAssignmentCarriers,
} from "./privateAssignments";

export {
	EXPORT_MODES,
	type ExportMode,
	type LookupTarget,
	type ManagedLookupTable,
	type ManagedLookupWorkbook,
} from "./boundaryFindings";

export type AvailableLookupValidationContext = Extract<
	LookupValidationContext,
	{ readonly kind: "available" }
>;

import {
	planLargeWorkbooks,
	type StreamLookupWorkbook,
} from "@/lib/commcare/lookup/archiveWorkbooks";
import { describeLookupCarrierAlternative } from "@/lib/commcare/lookup/carrier";
import {
	measureStreamedLookupFixtures,
	plannedLookupFixtureBudget,
} from "@/lib/commcare/lookup/streamSuite";
import { prepareArchiveTables } from "@/lib/deployment/prepareArchiveTables";
import type {
	ArchiveLookupAccess,
	StreamingLookupTable,
} from "@/lib/lookup/archiveRows";

export interface PrepareExportBoundaryInput {
	readonly mode: ExportMode;
	readonly installTarget?: { server: string; domain: string; appId: string };
	readonly streamMedia?: boolean;
	readonly archiveActor?: () => Pick<
		ArchiveLookupAccess,
		"appId" | "grant" | "recheck"
	>;
	readonly assignmentAccess?: DestinationOwnerAccess;
	readonly beforeLookupRead?: () => Promise<void>;
	/** Authorized Project identity and role from the app access gate. */
	readonly access: ProjectAccess;
	/** Hydrated blueprint from the same app load as `compiledAtSeq`. */
	readonly doc: BlueprintDoc;
	readonly compiledAtSeq: number;
	/**
	 * Where this export's attachment links resolve, already decided by the
	 * caller.
	 *
	 * Resolved rather than looked up here for the same reason the lookup
	 * snapshot is read exactly once: the boundary consumes one generation of
	 * external state and never asks a second time. A direct HQ upload knows
	 * its own target authoritatively; a downloadable app or import file
	 * resolves the app's deployment record, and `null` when that record names
	 * no project space, or more than one.
	 */
	readonly attachmentTarget: AttachmentUrlTarget | null;
	/**
	 * The media paths the export's target holds, by asset: a file that came
	 * in from CommCare HQ keeps its path on the project space it came from.
	 * Absent, every file takes its content-hash path.
	 */
	readonly heldMediaPaths?: ReadonlyMap<MediaAssetId, string>;
	/**
	 * The project space a direct upload writes to, which `hq-upload` passes
	 * and the other two modes do not: a table CommCare HQ manages there is
	 * left out of the workbook, so Nova never writes it there.
	 */
	readonly lookupTarget?: LookupTarget;
	/**
	 * `hq-upload`'s tables that already have a JSON destination on
	 * `lookupTarget`, which keep travelling through CommCare HQ's JSON
	 * resources (`boundaryFindings.ts::ExportCarrierFindingsInput`).
	 */
	readonly jsonDestinationTableIds?: ReadonlySet<string>;
	/**
	 * `hq-upload`'s tables the Project already has on `lookupTarget` through
	 * a workbook, with the tags they are there under, which stay in the
	 * workbook (`boundaryFindings.ts::ExportCarrierFindingsInput`).
	 */
	readonly workbookLookupTags?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * The exact external-resource generation validated for one export.
 *
 * `lookupSnapshot.definitions` and `lookupContext.definitions` are the same
 * array object, and the snapshot carries every referenced table's complete
 * ordered rows on every mode. Emitters and the resource push consume this
 * value directly; a second lookup read after validation would create a
 * generation-skew race and is forbidden — the bytes CommCare HQ is sent
 * must be the bytes that were validated.
 */
export interface PreparedExportBoundary {
	readonly streamedTables?: readonly StreamingLookupTable[];
	readonly streamedWorkbooks?: readonly StreamLookupWorkbook[];
	readonly mode: ExportMode;
	readonly assignmentWitness?: AssignmentWitness;
	readonly doc: BlueprintDoc;
	readonly compiledAtSeq: number;
	readonly assets: Awaited<ReturnType<typeof resolveMediaManifest>>;
	readonly lookupTargets: LookupReferenceTargetSet;
	readonly lookupSnapshot: LookupFixtureDataSnapshot;
	readonly lookupContext: AvailableLookupValidationContext;
	/**
	 * What each referenced table and column is called on the wire, from the
	 * same snapshot generation the validator saw. Present on EVERY mode when
	 * the doc references a table, because every mode emits the app: a
	 * lookup-backed select compiles to an `instance(...)` reference whatever
	 * carries the data, and `buildXForm` throws without this. `.ccz` embeds
	 * the rows beside it, the two HQ modes put them on the project space,
	 * and the app JSON is the same either way.
	 */
	readonly lookupNaming?: LookupWireNaming;
	/**
	 * The above plus budget-checked fixture blocks. Present exactly on
	 * `ccz` — the one mode that embeds its lookup data as suite fixtures —
	 * and absent when the doc references no table.
	 */
	readonly lookupWire?: PreparedLookupWire;
	/** The target the emitters build attachment links against, or `null`. */
	readonly attachmentTarget: AttachmentUrlTarget | null;
	/**
	 * The same tables as the workbook CommCare HQ's fixture upload reads.
	 * Present on the two HQ modes when some table the doc references goes:
	 * the upload pushes it before the app goes out, and the manual import
	 * artifact ships it beside the app JSON so a hand-imported app has its
	 * data too. It holds every referenced table but those in
	 * `managedLookupTables`, and is absent where no table goes.
	 */
	readonly lookupWorkbook?: LookupWorkbook;
	/**
	 * Every table the mode left out of `lookupWorkbook`, in the definitions'
	 * order: for `hq-upload`, each table CommCare HQ manages in its
	 * `lookupTarget`; for `hq-json`, each table CommCare HQ manages; for
	 * `ccz`, none.
	 */
	readonly managedLookupTables: readonly ManagedLookupTable[];
	/**
	 * The HQ app file's workbooks of the tables CommCare HQ manages: Nova's
	 * copy of each project space's tables in a workbook of its own, which a
	 * person importing into that project space leaves out. On `hq-json`
	 * only, one per project space that manages a table the app reads; empty
	 * everywhere else.
	 */
	readonly managedLookupWorkbooks: readonly ManagedLookupWorkbook[];
	/**
	 * `hq-upload`'s tables that travel through CommCare HQ's JSON resources
	 * rather than `lookupWorkbook`, their rows in `lookupSnapshot`
	 * (`boundaryFindings.ts::ExportCarrierFindings.jsonLookupTables`). Absent
	 * where none does.
	 */
	readonly jsonLookupTables?: readonly LookupTableWireNaming[];
}

export type PrepareExportBoundaryResult =
	| { readonly ok: true; readonly prepared: PreparedExportBoundary }
	| { readonly ok: false; readonly violations: readonly ValidationError[] };

/**
 * What the boundary reads from outside the document: the Project's lookup
 * data and media rows from Nova's database, and the media bytes from
 * object storage. Production reads them live. A caller that holds a
 * Project's state itself passes its own reads, so the verdict and the
 * prepared export still come from this module.
 */
export interface ExportBoundaryReads {
	/** The requested tables' definitions and complete ordered rows, for the export mode. */
	readonly lookupFixtureData: (
		scope: LookupScope,
		tableIds: readonly LookupTableId[],
		mode: ExportMode,
	) => Promise<LookupFixtureDataSnapshot>;
	/** The Project's rows for the requested uploaded media ids. */
	readonly mediaRows: (
		ids: readonly MediaAssetId[],
		projectId: string,
	) => Promise<MediaAssetRecord[]>;
	/**
	 * The document's media manifest, with the bytes of every asset, each at
	 * the path `heldPaths` names for it or else at its content-hash path.
	 */
	readonly mediaManifest: (
		doc: BlueprintDoc,
		projectId: string,
		heldPaths?: ReadonlyMap<MediaAssetId, string>,
		streamMedia?: boolean,
	) => Promise<Awaited<ReturnType<typeof resolveMediaManifest>>>;
}

const PRODUCTION_READS: ExportBoundaryReads = {
	lookupFixtureData: (scope, tableIds, mode) =>
		getLookupFixtureData(
			scope,
			tableIds,
			mode === "ccz" ? "download-export" : "export",
		),
	mediaRows: (ids, projectId) => loadAssetsByIds(ids, projectId),
	mediaManifest: (doc, projectId, heldPaths, streamMedia) =>
		resolveMediaManifest(doc, projectId, {
			withBytes: !streamMedia,
			streamBytes: streamMedia,
			...(heldPaths !== undefined && { heldPaths }),
		}),
};

/** Build the available validator context without cloning its exact snapshot. */
function availableLookupContext(
	snapshot: LookupFixtureDataSnapshot,
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
 * lookup context, and hands it the mode's `rowFindings` from
 * {@link exportCarrierFindings}; the focused exported wrapper below fixes
 * this to the production registry, with no mode, for legacy media-rule
 * coverage.
 */
async function collectViolationsWithRegistry(
	doc: BlueprintDoc,
	projectId: string,
	lookupContext: LookupValidationContext,
	lookupReferenceExtractors: LookupReferenceExtractorRegistry,
	rowFindings: readonly ValidationError[] = [],
	reads: ExportBoundaryReads = PRODUCTION_READS,
	streamMedia = false,
): Promise<ValidationError[]> {
	const ids = [...collectAssetRefs(doc)];
	const { realIds, builtinSlugs } = partitionAssetRefs(ids);

	/* Bound the metadata read itself. The doc schema does not cap distinct
	 * references, so waiting until after rows load would leave an unbounded
	 * allocation ahead of the aggregate budget verdict. */
	const exportableRefCount = realIds.length + builtinSlugs.length;
	if (!streamMedia && exportableRefCount > MAX_MEDIA_EXPORT_ASSETS) {
		return [
			validationError(
				"MEDIA_EXPORT_TOO_LARGE",
				"app",
				`This app references too many attachments to export: ${exportableRefCount} (the limit is ${MAX_MEDIA_EXPORT_ASSETS}). Remove some attachments, then export again.`,
				{},
			),
			...rowFindings,
		];
	}

	const realRows =
		realIds.length === 0 ? [] : await reads.mediaRows(realIds, projectId);
	const rows = [...realRows, ...builtinAssetRows(builtinSlugs)];
	const mediaAssets = new Map(rows.map((row) => [row.id as string, row]));
	const errors = evaluateBoundary(
		doc,
		mediaAssets,
		lookupContext,
		lookupReferenceExtractors,
	);
	const budgetError = streamMedia ? null : exportBudgetError(rows);
	return [
		...errors,
		...rowFindings,
		...(budgetError === null ? [] : [budgetError]),
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
		`This app bundles too much media to export: ${excess.reasons.join(
			" and ",
		)}. Remove or shrink some attachments, then export again.`,
		{},
	);
}

async function prepareWithRegistry(
	input: PrepareExportBoundaryInput,
	registry: LookupReferenceExtractorRegistry,
	reads: ExportBoundaryReads = PRODUCTION_READS,
): Promise<PrepareExportBoundaryResult> {
	const lookupTargets = extractLookupReferenceTargets(input.doc, registry);
	const scope = {
		projectId: input.access.projectId,
		actorId: input.access.actorUserId,
		role: input.access.role,
	};

	/* Always read, including `[]`, and always with rows. Besides definitions,
	 * the read captures the Project revision that identifies this exact
	 * snapshot, and the service uses one read-only REPEATABLE READ
	 * transaction — so validation, the row-dependent verdicts, and whatever
	 * carries the data outward all consume ONE generation. Every mode needs
	 * the rows now: `ccz` embeds them as fixtures, and the two HQ modes turn
	 * them into the workbook CommCare HQ reads. Any operational failure
	 * intentionally throws through this function; it is not a document
	 * finding and must stop the export rather than masquerade as unavailable
	 * context. */
	if (lookupTargets.tableIds.length) await input.beforeLookupRead?.();
	const genericData = await reads.lookupFixtureData(
		scope,
		lookupTargets.tableIds,
		input.mode,
	);
	const restoreIds =
		input.mode === "ccz" && input.installTarget
			? genericData.definitions
					.filter(
						(t) =>
							t.workerAccess === "assigned" ||
							t.hq?.source?.distribution === "assigned" ||
							requiresLookupProjection(t.hq),
					)
					.map((t) => t.id)
			: [];
	let restoreWitness: AssignmentWitness | undefined;
	if (restoreIds.length && input.installTarget) {
		const actor = input.archiveActor?.();
		if (!actor)
			throw new ApiError(
				"This installation needs a current connection to its project space.",
				403,
			);
		const { server, domain, appId: targetAppId } = input.installTarget;
		const target = { server, domain };
		const restore = await installLookupWitness(
			{
				scope: {
					appId: actor.appId,
					projectId: scope.projectId,
					actorUserId: scope.actorId,
				},
				grant: actor.grant,
				target,
			},
			targetAppId,
			restoreIds,
		);
		restoreWitness = { target, tables: [], restore };
	}
	const assignment =
		input.assignmentAccess &&
		(input.assignmentAccess.purpose !== "publish" ||
			genericData.definitions.some((t) => t.workerAccess === "assigned"))
			? await readAssignmentCarriers(input.assignmentAccess, genericData)
			: undefined;
	const fixtureData = assignment?.snapshot ?? genericData;
	const lookupSnapshot: LookupFixtureDataSnapshot = fixtureData;
	if (lookupSnapshot.projectId !== input.access.projectId) {
		throw new Error(
			"Lookup definition reader returned a snapshot for the wrong Project.",
		);
	}
	const lookupContext = availableLookupContext(lookupSnapshot);
	/* The mode's carrier and its row and mode verdicts, over this one
	 * snapshot. The selection findings are read only once the document's own
	 * verdict has passed. */
	const buildCarrier = () =>
		exportCarrierFindings({
			doc: input.doc,
			mode: input.mode,
			fixtureData,
			assignments: assignment?.owners,
			restoreTableIds: new Set(restoreIds),
			...(input.lookupTarget !== undefined && {
				lookupTarget: input.lookupTarget,
			}),
			...(input.jsonDestinationTableIds !== undefined && {
				jsonDestinationTableIds: input.jsonDestinationTableIds,
			}),
			...(input.workbookLookupTags !== undefined && {
				workbookLookupTags: input.workbookLookupTags,
			}),
		});
	const ccZCarrier =
		input.mode === "ccz" && lookupSnapshot.streamedTables?.size
			? buildCarrier()
			: undefined;
	const compiledFixtures = ccZCarrier?.lookupWire?.fixtures;
	const ccZBudget =
		compiledFixtures && lookupSnapshot.streamedTables
			? plannedLookupFixtureBudget(
					compiledFixtures,
					lookupSnapshot.streamedTables,
				)
			: undefined;
	if (ccZBudget) {
		const findings = lookupFixtureBudgetFindings(ccZBudget);
		if (findings.length) return { ok: false, violations: findings };
	}
	const actor = lookupSnapshot.streamedTables?.size
		? input.archiveActor?.()
		: undefined;
	const streamed = await prepareArchiveTables(
		input.doc,
		lookupSnapshot,
		actor && {
			...actor,
			projectId: scope.projectId,
			actorUserId: scope.actorId,
			documentRevision: input.compiledAtSeq,
			projectRevision: lookupSnapshot.projectRevision,
		},
		input.mode === "hq-upload",
	);
	if (streamed.issues.length) return { ok: false, violations: streamed.issues };
	const workbookPlan =
		input.mode === "ccz"
			? { files: [], alternatives: [] }
			: await planLargeWorkbooks([...streamed.tables.values()]);
	if (workbookPlan.alternatives.length)
		return {
			ok: false,
			violations: workbookPlan.alternatives.map((item) =>
				validationError(
					"LOOKUP_WORKER_SOURCE_UNAVAILABLE",
					"app",
					/* Only a table held as a streamed generation reaches here, and
					 * no carrier takes one exactly yet, the direct publish included. */
					describeLookupCarrierAlternative(
						item.table.definition.name,
						item.carrier,
						"too-large",
					),
					{},
					{
						tableId: item.table.definition.id,
						tableName: item.table.definition.name,
						delivery: item.carrier.kind,
					},
				),
			),
		};

	const carrier = ccZCarrier ?? buildCarrier();
	const {
		naming,
		lookupWire,
		lookupWorkbook,
		managedLookupTables,
		managedLookupWorkbooks,
	} = carrier;

	/* This subordinate loader evaluates the complete document gate with both
	 * the exact lookup context and the Project-filtered media rows. It returns
	 * findings only; operational media reads continue to throw. */
	const violations = await collectViolationsWithRegistry(
		input.doc,
		input.access.projectId,
		lookupContext,
		registry,
		carrier.rowFindings,
		reads,
		input.streamMedia,
	);
	if (violations.length > 0) {
		return { ok: false, violations };
	}
	if (carrier.selectionFindings.length > 0) {
		return { ok: false, violations: carrier.selectionFindings };
	}

	if (ccZBudget) {
		const { budget, incomplete } = await measureStreamedLookupFixtures(
			ccZBudget,
			[...streamed.tables.values()],
		);
		const findings = lookupFixtureBudgetFindings(budget, incomplete);
		if (findings.length) return { ok: false, violations: findings };
	}

	/* Bytes are resolved only after the complete boundary succeeds. All three
	 * current targets need bytes: CCZ embeds them, HQ JSON ships its sidecar
	 * bundle, and HQ upload sends its media bundle after import. */
	const assets = await reads.mediaManifest(
		input.doc,
		input.access.projectId,
		input.heldMediaPaths,
		...(input.streamMedia === undefined ? [] : [input.streamMedia]),
	);

	return {
		ok: true,
		prepared: {
			mode: input.mode,
			...((assignment || restoreWitness) && {
				assignmentWitness: assignment?.witness ?? restoreWitness,
			}),
			...(streamed.tables.size > 0 && {
				streamedTables: [...streamed.tables.values()],
			}),
			...(workbookPlan.files.length > 0 && {
				streamedWorkbooks: workbookPlan.files,
			}),
			doc: input.doc,
			compiledAtSeq: input.compiledAtSeq,
			assets,
			lookupTargets,
			lookupSnapshot,
			lookupContext,
			...(naming !== undefined && { lookupNaming: naming }),
			...(lookupWire !== undefined && { lookupWire }),
			attachmentTarget: input.attachmentTarget,
			...(lookupWorkbook !== undefined && { lookupWorkbook }),
			managedLookupTables,
			managedLookupWorkbooks,
			...(carrier.jsonLookupTables.length > 0 && {
				jsonLookupTables: carrier.jsonLookupTables,
			}),
		},
	};
}

/** Prepare one authoritative export using the immutable production registry. */
export function prepareExportBoundary(
	input: PrepareExportBoundaryInput,
): Promise<PrepareExportBoundaryResult> {
	return prepareWithRegistry(input, PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS);
}

/**
 * Prepare one export exactly as {@link prepareExportBoundary} does, over
 * Project state the caller holds rather than state read live. Every Nova
 * surface exports through {@link prepareExportBoundary}; this is for a
 * caller outside Nova's database, such as the proof harness's publish
 * capture, whose verdict must be the boundary's own.
 */
export function prepareExportBoundaryWithReads(
	input: PrepareExportBoundaryInput,
	reads: ExportBoundaryReads,
): Promise<PrepareExportBoundaryResult> {
	return prepareWithRegistry(
		input,
		PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
		reads,
	);
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
 * Synthetic-carrier seam for race and boundary tests. Production export
 * entry points must use {@link prepareExportBoundary}; a new carrier kind
 * joins the shared production registry instead of injecting a caller-owned
 * one.
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
