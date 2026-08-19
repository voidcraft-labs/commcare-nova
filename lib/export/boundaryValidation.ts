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
	buildLookupFixtures,
	type CompiledLookupFixtureSet,
	lookupFixtureBudgetExcess,
	type PreparedLookupWire,
} from "@/lib/commcare/lookup/fixtures";
import {
	type LookupWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import { lookupSelectSourceRowFindings } from "@/lib/commcare/lookup/selectSourceRows";
import {
	buildLookupWorkbook,
	type LookupWorkbook,
	MAX_HQ_FIXTURE_SHEET_NAME_LENGTH,
	MAX_HQ_FIXTURE_WORKBOOK_ROWS,
	TYPES_SHEET,
} from "@/lib/commcare/lookup/workbook";
import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import { evaluateBoundary } from "@/lib/commcare/validator/gate";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
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
import { walkExpressionTerms } from "@/lib/domain/predicate";
import { getLookupFixtureData } from "@/lib/lookup/service";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
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
	readonly mode: ExportMode;
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
	 * Present on the two HQ modes when the doc references a table: the
	 * upload pushes it before the app goes out, and the manual import
	 * artifact ships it beside the app JSON so a hand-imported app has its
	 * data too.
	 */
	readonly lookupWorkbook?: LookupWorkbook;
}

export type PrepareExportBoundaryResult =
	| { readonly ok: true; readonly prepared: PreparedExportBoundary }
	| { readonly ok: false; readonly violations: readonly ValidationError[] };

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
				`This app references too many attachments to export: ${exportableRefCount} (the limit is ${MAX_MEDIA_EXPORT_ASSETS}). Remove some attachments, then export again.`,
				{},
			),
			...lookupExportFindings(doc, mode, lookupRows),
			...organizationExportFindings(doc, mode),
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
	return [
		...errors,
		...lookupExportFindings(doc, mode, lookupRows),
		...organizationExportFindings(doc, mode),
		...(budgetError === null ? [] : [budgetError]),
	];
}

/**
 * The one owner term that cannot cross an export boundary.
 *
 * The fixture is not what decides this, which is worth saying first
 * because it used to be half the stated reason. `owner-location-at-level`
 * reads `instance('locations')`, and that is CommCare's own restore
 * fixture on every mode alike (`jr://fixture/locations`; Nova emits no
 * copy, and the flat serializer under `lib/commcare/locations/__tests__`
 * is an oracle rather than a producer). `fixed-location` reads no
 * instance at all — `predicate/instances.ts` groups it with `literal`.
 * What decides this is WHOSE IDENTITIES the printed expression carries.
 *
 * `owner-location-at-level` carries none of Nova's.
 * `termEmitter.ts::emitTerm` prints level CODES, which a publish puts on
 * the project space as `location_type_code` and which are therefore the
 * same word on both sides, and matches them against the case's own
 * `owner_id`, which is CommCare HQ's value at runtime. Every part of that
 * expression means the same thing over there, so it exports.
 *
 * What that expression DOES assume is three things about the target
 * project space, none of which Nova can see from here, and all of which a
 * publish to a space Nova pushed makes true. Each is stated because it
 * cannot be closed from here, not as a note to somebody later:
 *
 *   * **It spells its levels the way Nova does.** A publish writes each
 *     level's code as `location_type_code`, so a direct upload is sound by
 *     construction. A downloadable app or an import file dropped into a
 *     project space whose organization somebody built by hand can carry
 *     different codes, and the rule then selects nothing.
 *   * **It has the LOCATIONS privilege.**
 *     `locations/fixtures.py::should_sync_flat_fixture` answers False
 *     unless `domain/models.py::Domain.uses_locations` (that privilege,
 *     plus commtrack or at least one `LocationType`). A publish proves it,
 *     since the location push takes a 403 without it, and a `.ccz` or
 *     import file cannot. This one is not quiet: with no fixture the
 *     device fails to resolve the instance rather than matching nobody.
 *
 *     Whether the project space's own
 *     `LocationFixtureConfiguration.sync_flat_fixture` row is on used to
 *     belong on this list and no longer does. `expander.ts` emits
 *     `location_fixture_restore: "both_fixtures"` on any app that reads
 *     the fixture, and `::should_sync_flat_fixture` returns True for that
 *     BEFORE it consults the row.
 *   * **Its tree has no second place under the same owner at the
 *     destination level.** What makes this expression yield ONE `@id`
 *     rather than a node-set is
 *     `lib/organization/commitIntegrity.ts::assertReverseHopTargetsUnambiguous`,
 *     and that runs over `app_locations` — Nova's tree. CommCare HQ builds
 *     the fixture from its own `SQLLocation` rows, which can hold places
 *     Nova never created or ones added after the publish. A publish
 *     re-proves it over there:
 *     `lib/deployment/preflight.ts` blocks on
 *     `ambiguousReverseHopsOnTarget`. A `.ccz` or an import file has no
 *     target to prove it against.
 *
 * A publish settles all three, and none is a reason to refuse an export:
 * they are the name-and-shape agreement every code-based binding Nova
 * emits already rests on, case types included, and refusing because a
 * target MIGHT disagree would refuse far more than this. What is left
 * unproved is the two modes that have no target to ask — and they are
 * named here rather than left to be noticed, because the first and third
 * fail QUIETLY: a predicate that matches nobody, or matches two, is not a
 * runtime error.
 *
 * `fixed-location` prints Nova's place UUID as a literal `owner_id`.
 * CommCare HQ keys its places by ids it minted itself, so that literal
 * names nobody there, and it does so quietly: an owner that resolves to
 * nothing is indistinguishable from an owner who is simply absent.
 *
 * This is a missing translation, not a missing feature, and it is not
 * permanent on any mode. The place mapping exists — the deployment
 * ledger holds Nova's place UUID against CommCare HQ's `location_id` —
 * and nothing threads it into emission yet. A direct upload knows its
 * target authoritatively and is where that will land first; the other two
 * resolve a target through the app's deployment record, exactly as
 * `PreparedExportBoundary.attachmentTarget` already does, and become
 * exportable for an app whose record names one project space. Hence one
 * message for all three: the reason is the same everywhere, and only the
 * availability of a target differs.
 */
function organizationExportFindings(
	doc: BlueprintDoc,
	mode: ExportMode | undefined,
): ValidationError[] {
	if (mode === undefined) return [];
	const findings: ValidationError[] = [];
	for (const form of Object.values(doc.forms)) {
		for (const [operationIndex, operation] of (
			form.caseOperations ?? []
		).entries()) {
			if (operation.owner === undefined) continue;
			let locationUuid: string | undefined;
			walkExpressionTerms(operation.owner, (term) => {
				if (term.kind === "fixed-location") locationUuid = term.locationUuid;
			});
			if (locationUuid === undefined) continue;
			findings.push(
				validationError(
					"LOCATION_OWNER_EXPORT_NOT_ACTIVE",
					"form",
					`A case owner set to one particular place cannot be exported as ${EXPORT_MODE_LABELS[mode]} yet. The exported rule names that place by Nova's own id, and your CommCare HQ project knows its places by different ids, so the rule would match nobody. Setting it to a place beneath the current case owner exports fine, so use that instead, or remove this rule.`,
					{
						formUuid: form.uuid,
					},
					{
						exportMode: mode,
						operationIndex: String(operationIndex),
						ownerKind: "fixed-location",
						locationUuid,
					},
				),
			);
		}
	}
	return findings;
}

/** The row-bearing generation each mode's lookup verdicts are drawn from. */
interface LookupRowVerdictInput {
	readonly fixtureData: LookupFixtureDataSnapshot;
	/** Built for `ccz` only: the bytes the archive would embed. */
	readonly fixtures?: CompiledLookupFixtureSet;
	/**
	 * The referenced tables' current wire identities, present on the two HQ
	 * modes only. Read for the checks that are about a NAME rather than
	 * about bytes, which must therefore run even when the workbook could
	 * not be built.
	 */
	readonly hqNaming?: LookupWireNaming;
	/** Built for the two HQ modes only: the bytes CommCare HQ would read. */
	readonly workbook?: LookupWorkbook;
}

/**
 * The mode's complete lookup verdict.
 *
 * The row-dependent checks are common to all three, because a choice list
 * whose saved values are blank or duplicated is equally broken however the
 * table reached the device. What differs is what each CARRIER can hold:
 * `ccz` embeds fixture XML into the archive and is bounded by what an
 * unindexed runtime can carry, while the HQ modes hand CommCare HQ a
 * workbook and are bounded both by the rows its importer takes and by the
 * length of a spreadsheet sheet name.
 */
function lookupExportFindings(
	doc: BlueprintDoc,
	mode: ExportMode | undefined,
	lookupRows: LookupRowVerdictInput | undefined,
): ValidationError[] {
	if (mode === undefined || lookupRows === undefined) return [];
	return [
		...lookupSelectSourceRowFindings(doc, lookupRows.fixtureData),
		...(lookupRows.fixtures === undefined
			? []
			: lookupFixtureBudgetFindings(lookupRows.fixtures)),
		...(lookupRows.hqNaming === undefined
			? []
			: [
					...lookupHqSheetNameFindings(lookupRows.hqNaming),
					...lookupHqReservedTagFindings(lookupRows.hqNaming),
				]),
		...(lookupRows.workbook === undefined
			? []
			: lookupWorkbookBudgetFindings(lookupRows.workbook)),
	];
}

/**
 * Whether any referenced tag is too long to be a data sheet's name.
 *
 * Read before the workbook is built, because the builder cannot name a
 * sheet it has no legal name for; the boundary refuses first so the
 * emitter stays total.
 */
function hasUnpushableTag(naming: LookupWireNaming): boolean {
	return naming.tables.some(
		(table) =>
			table.tag.length > MAX_HQ_FIXTURE_SHEET_NAME_LENGTH ||
			table.tag.toLowerCase() === TYPES_SHEET,
	);
}

/**
 * The tags CommCare HQ's fixture upload has no way to address.
 *
 * A table's rows travel on a sheet NAMED for its export tag, and a sheet
 * name holds at most 31 characters while a tag may be authored up to 32.
 * That one length is unpushable, and CommCare HQ's own answer for it is
 * "worksheet not found" against a sheet the author never named, so Nova
 * says which tag and how to fix it. Applies to both HQ modes, and to
 * neither the archive (whose fixtures are addressed by element name) nor
 * a commit, since a table's tag is Project data rather than app state.
 */
function lookupHqSheetNameFindings(
	naming: LookupWireNaming,
): ValidationError[] {
	return naming.tables
		.filter((table) => table.tag.length > MAX_HQ_FIXTURE_SHEET_NAME_LENGTH)
		.map((table) =>
			validationError(
				"LOOKUP_TAG_TOO_LONG_FOR_HQ",
				"app",
				`CommCare HQ reads each lookup table from a sheet named for its export tag, and a sheet name holds at most ${MAX_HQ_FIXTURE_SHEET_NAME_LENGTH} characters. The export tag ${table.tag} is ${table.tag.length}. Shorten it in Project data, then try again.`,
				{},
				{
					tag: table.tag,
					tagLength: String(table.tag.length),
					tagAllowed: String(MAX_HQ_FIXTURE_SHEET_NAME_LENGTH),
				},
			),
		);
}

/**
 * The one tag CommCare HQ has already spent on itself.
 *
 * Every upload carries a mandatory sheet named `types` listing the tables
 * in it, so a table whose own tag is `types` has nowhere to put its rows.
 * Nova would throw appending the second sheet and CommCare HQ would read
 * the wrong one, so the boundary refuses first and the emitter stays
 * total. Sheet names are matched case-insensitively, so `Types` collides
 * just as `types` does.
 */
function lookupHqReservedTagFindings(
	naming: LookupWireNaming,
): ValidationError[] {
	return naming.tables
		.filter((table) => table.tag.toLowerCase() === TYPES_SHEET)
		.map((table) =>
			validationError(
				"LOOKUP_TAG_RESERVED_BY_HQ",
				"app",
				`CommCare HQ keeps the sheet name ${TYPES_SHEET} for its own list of the tables in an upload, so the export tag ${table.tag} has nowhere to put its rows. Rename it in Project data, then try again.`,
				{},
				{ tag: table.tag, reservedTag: TYPES_SHEET },
			),
		);
}

const EXPORT_MODE_LABELS: Readonly<Record<ExportMode, string>> = {
	ccz: "a downloadable app",
	"hq-json": "an HQ import file",
	"hq-upload": "a direct HQ upload",
};

/**
 * What CommCare HQ's fixture importer will take in one workbook.
 *
 * The limit is a whole-workbook row total across every sheet, headers
 * included (`fixtures/upload/const.py::MAX_FIXTURE_ROWS`, applied in
 * `util/workbook_json/excel.py::WorkbookJSONReader.__init__`). Nova's own
 * 5,000-row per-table cap puts it about a hundred tables away, so this
 * fires only for an app referencing an unusual number of them — but when
 * it does, CommCare HQ's own refusal names a limit nobody set in Nova, so
 * Nova measures it first and says which tables are large.
 */
function lookupWorkbookBudgetFindings(
	workbook: LookupWorkbook,
): ValidationError[] {
	if (workbook.totalWorkbookRows <= MAX_HQ_FIXTURE_WORKBOOK_ROWS) return [];
	const largest = [...workbook.tables]
		.sort((left, right) => right.rowCount - left.rowCount)
		.slice(0, 3);
	return [
		validationError(
			"LOOKUP_HQ_PUSH_TOO_LARGE",
			"app",
			`This app references more lookup data than CommCare HQ accepts in one upload: ${workbook.totalWorkbookRows.toLocaleString(
				"en-US",
			)} rows (the limit is ${MAX_HQ_FIXTURE_WORKBOOK_ROWS.toLocaleString(
				"en-US",
			)}). The largest tables are ${largest
				.map((table) => table.tag)
				.join(", ")}; shrink or split them, or remove some lookup references.`,
			{},
			{
				rowsActual: String(workbook.totalWorkbookRows),
				rowsAllowed: String(MAX_HQ_FIXTURE_WORKBOOK_ROWS),
				largestTables: largest
					.map((table) => `${table.tag}:${table.rowCount}`)
					.join(","),
			},
		),
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
			`This app references more lookup data than a downloadable app can bundle: ${axisSummaries.join(
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
		`This app bundles too much media to export: ${excess.reasons.join(
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
	const fixtureData = await getLookupFixtureData(scope, lookupTargets.tableIds);
	const lookupSnapshot: LookupFixtureDataSnapshot = fixtureData;
	if (lookupSnapshot.projectId !== input.access.projectId) {
		throw new Error(
			"Lookup definition reader returned a snapshot for the wrong Project.",
		);
	}
	const lookupContext = availableLookupContext(lookupSnapshot);

	/* The carrier for this mode is built BEFORE the verdict, so the size
	 * limit measures the exact bytes that would go out rather than an
	 * estimate of them, and the built artifact is reused on success rather
	 * than rebuilt. An app referencing no table builds neither. */
	const naming =
		lookupTargets.tableIds.length === 0
			? undefined
			: lookupWireNaming(fixtureData.definitions);
	const lookupWire =
		naming === undefined || input.mode !== "ccz"
			? undefined
			: {
					naming,
					fixtures: buildLookupFixtures(naming, fixtureData.rowsByTable),
				};
	const lookupWorkbook =
		naming === undefined || input.mode === "ccz" || hasUnpushableTag(naming)
			? undefined
			: buildLookupWorkbook(naming, fixtureData.rowsByTable);

	/* This subordinate loader evaluates the complete document gate with both
	 * the exact lookup context and the Project-filtered media rows. It returns
	 * findings only; operational media reads continue to throw. */
	const violations = await collectViolationsWithRegistry(
		input.doc,
		input.access.projectId,
		lookupContext,
		registry,
		input.mode,
		{
			fixtureData,
			...(lookupWire !== undefined && { fixtures: lookupWire.fixtures }),
			...(naming !== undefined && input.mode !== "ccz" && { hqNaming: naming }),
			...(lookupWorkbook !== undefined && { workbook: lookupWorkbook }),
		},
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
			...(naming !== undefined && { lookupNaming: naming }),
			...(lookupWire !== undefined && { lookupWire }),
			attachmentTarget: input.attachmentTarget,
			...(lookupWorkbook !== undefined && { lookupWorkbook }),
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
