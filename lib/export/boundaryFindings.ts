/**
 * The row and mode verdicts of an export: what the mode's lookup carrier
 * can hold, what a fixed-place owner means on the target, and the two
 * nested selections CommCare HQ cannot carry.
 *
 * The document's own verdict (`evaluateBoundary`) needs no mode. These do:
 * they judge the rows of the tables the document reads, and the carrier
 * that takes them to the device, which is fixture XML for `ccz` and a
 * fixapi workbook for the two HQ modes. They are computed here, over one
 * lookup snapshot the caller already holds, so a caller that must not read
 * the database reaches the same answers the export boundary gives. This
 * module reads nothing: no database, no object storage, no clock.
 */

import { hqNestedSelectionFindings } from "@/lib/commcare/hqNestedSelection";
import {
	alternativeLookupCarrier,
	describeLookupCarrierAlternative,
} from "@/lib/commcare/lookup/carrier";
import {
	buildLookupFixtures,
	type CompiledLookupFixtureSet,
	lookupFixtureBudgetExcess,
	type PreparedLookupWire,
} from "@/lib/commcare/lookup/fixtures";
import { lookupHqCellTextFindings } from "@/lib/commcare/lookup/hqCellText";
import {
	type LookupTableWireNaming,
	type LookupWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import { lookupSelectSourceRowFindings } from "@/lib/commcare/lookup/selectSourceRows";
import {
	buildLookupWorkbook,
	type LookupWorkbook,
	MAX_HQ_FIXTURE_WORKBOOK_ROWS,
	TYPES_SHEET,
} from "@/lib/commcare/lookup/workbook";
import {
	type LookupWorkbookOwners,
	lookupWorkbookShape,
	observeLookupWorkbookRow,
} from "@/lib/commcare/lookup/workbookRows";
import { lookupXmlTextFindings } from "@/lib/commcare/lookup/xmlText";
import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import type { BlueprintDoc } from "@/lib/domain";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { requiresLookupProjection } from "@/lib/lookup/source";
import type {
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
	LookupTableDefinition,
	LookupTableId,
} from "@/lib/lookup/types";

export const EXPORT_MODES = ["ccz", "hq-json", "hq-upload"] as const;
export type ExportMode = (typeof EXPORT_MODES)[number];

export interface ExportCarrierFindingsInput {
	readonly doc: BlueprintDoc;
	readonly mode: ExportMode;
	/** One generation of the tables the document reads: definitions and rows. */
	readonly fixtureData: LookupFixtureDataSnapshot;
	readonly restoreTableIds?: ReadonlySet<LookupTableId>;
	readonly assignments?: ReadonlyMap<
		LookupTableId,
		ReadonlyMap<string, LookupWorkbookOwners>
	>;
	/**
	 * The project space a direct upload writes to: its server and domain. A
	 * table CommCare HQ manages there is left out of the workbook, so Nova
	 * never writes it there. `hq-upload` passes it; the other two modes are
	 * made for no project space and do not.
	 */
	readonly lookupTarget?: LookupTarget;
	/**
	 * `hq-upload`'s tables that already have a JSON destination ledger on
	 * `lookupTarget` (`lib/deployment/lookupJsonLedger.ts`): they keep
	 * travelling through CommCare HQ's JSON resources while those can carry
	 * them, since a workbook would replace the rows the ledger names.
	 */
	readonly jsonDestinationTableIds?: ReadonlySet<string>;
	/**
	 * `hq-upload`'s tables the Project already has on `lookupTarget` through
	 * a workbook, by table id, each with the tags it is there under: a live
	 * mapping of any of the Project's apps, or a table taken over from there
	 * (`lib/deployment/store.ts::readWorkbookLookupTags`). Such a table under
	 * such a tag stays in the workbook, since the JSON resources cannot take
	 * over rows that carry no Nova identity; its findings name what the
	 * workbook cannot carry.
	 */
	readonly workbookLookupTags?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** A project space by its server and domain, as a table's origin names one. */
export interface LookupTarget {
	readonly server: string;
	readonly domain: string;
}

/** A table CommCare HQ manages that the mode left out of its main workbook. */
export interface ManagedLookupTable {
	readonly tableId: LookupTableId;
	readonly tag: string;
	readonly name: string;
	/** The project space that manages it: its server and domain. */
	readonly server: string;
	readonly domain: string;
	/** When Nova's copy was last refreshed from that project space. */
	readonly refreshedAt: string;
}

/**
 * One workbook of the HQ app file's tables CommCare HQ manages: Nova's copy
 * of every table one project space manages. One per project space, so a
 * person importing into a space that manages some of them leaves out that
 * space's file alone and uploads every other space's.
 */
export interface ManagedLookupWorkbook {
	/** The project space that manages its tables: its server and domain. */
	readonly server: string;
	readonly domain: string;
	readonly workbook: LookupWorkbook;
}

export interface ExportCarrierFindings {
	/**
	 * What each table the snapshot holds is called on the wire. Absent when
	 * the snapshot holds no table, so a document that reads none builds no
	 * carrier. The app is emitted under it whatever carries the tables.
	 */
	readonly naming: LookupWireNaming | undefined;
	/** The `ccz` fixture blocks, built when no cell refuses them. */
	readonly lookupWire: PreparedLookupWire | undefined;
	/**
	 * The two HQ modes' fixapi workbook, built when no cell or tag refuses
	 * it: every table the snapshot holds but those in `managedLookupTables`.
	 * Undefined where no table goes.
	 */
	readonly lookupWorkbook: LookupWorkbook | undefined;
	/**
	 * Every table the mode left out of `lookupWorkbook`, in the definitions'
	 * order: for `hq-upload`, each table CommCare HQ manages in
	 * `lookupTarget`; for `hq-json`, each table CommCare HQ manages anywhere;
	 * for `ccz`, none, since the archive embeds every table.
	 */
	readonly managedLookupTables: readonly ManagedLookupTable[];
	/**
	 * `hq-json`'s workbooks of the tables in `managedLookupTables`, one per
	 * project space that manages some of them, in the order those tables
	 * first name each space, built when no cell or tag refuses them. Empty in
	 * the other two modes and where no table is managed.
	 */
	readonly managedLookupWorkbooks: readonly ManagedLookupWorkbook[];
	/**
	 * `hq-upload`'s tables that travel through CommCare HQ's JSON resources
	 * instead of the workbook (`lib/deployment/lookupJsonExecutor.ts`), in
	 * the definitions' order: a global table with no index whose rows the
	 * workbook cannot carry exactly, or that already has a JSON destination
	 * there. Empty in the other two modes.
	 */
	readonly jsonLookupTables: readonly LookupTableWireNaming[];
	/** `lookupExportFindings`, then `organizationExportFindings`: the order
	 *  the export boundary joins them in, after the document's own verdict. */
	readonly rowFindings: readonly ValidationError[];
	/**
	 * `hqNestedSelectionFindings`, for the two HQ modes; empty for `ccz`.
	 *
	 * Computed when first read. It walks the entry projection, which prints
	 * every expression an entry reads with `naming`, so it is read only once
	 * the document's own verdict has passed: a table the document reads that
	 * the snapshot lacks is that verdict's finding, and the projection cannot
	 * name it.
	 */
	readonly selectionFindings: readonly ValidationError[];
}

/**
 * Build the mode's lookup carrier over one snapshot and judge the rows,
 * the carrier and the mode.
 *
 * The carrier is built BEFORE the verdict, so the size limit measures the
 * exact bytes that would go out rather than an estimate of them, and the
 * built artifact is reused on success rather than rebuilt.
 */
export function exportCarrierFindings(
	input: ExportCarrierFindingsInput,
): ExportCarrierFindings {
	const { doc, mode, fixtureData } = input;
	const naming =
		fixtureData.definitions.length === 0
			? undefined
			: lookupWireNaming(fixtureData.definitions);
	const referenced = fixtureData.definitions.filter((table) => {
		if (mode === "ccz" && input.restoreTableIds?.has(table.id)) return false;
		const assigned =
			table.workerAccess === "assigned" ||
			table.hq?.source?.distribution === "assigned";
		if (mode !== "hq-json") return true;
		// A portable workbook would change the source's definition if its indexes
		// were guessed. The import file names the live source and destination setup.
		if (
			table.hq?.managedBy === "commcare-hq" &&
			(table.hq.source?.indexEvidence === "unobserved" ||
				table.columns.some((column) => column.index === "unobserved"))
		)
			return false;
		return !(
			(assigned || requiresLookupProjection(table.hq)) &&
			!input.assignments?.has(table.id)
		);
	});
	const unavailable = referenced.filter(
		(table) =>
			(requiresLookupProjection(table.hq) ||
				(table.workerAccess === "assigned" &&
					!input.assignments?.has(table.id))) &&
			!(
				mode === "hq-upload" &&
				leftOutOfMainWorkbook(table, mode, input.lookupTarget)
			),
	);
	if (unavailable.length)
		return {
			naming,
			lookupWire: undefined,
			lookupWorkbook: undefined,
			managedLookupTables: [],
			managedLookupWorkbooks: [],
			jsonLookupTables: [],
			rowFindings: unavailable.map((table) =>
				validationError(
					"LOOKUP_WORKER_SOURCE_UNAVAILABLE",
					"app",
					`“${table.name}” needs a verified data source for this destination. You can prepare its table in the project space or refresh worker data in Project data.`,
					{},
					{ tableId: table.id, tableName: table.name },
				),
			),
			selectionFindings: [],
		};
	const leftOut = referenced.filter((definition) =>
		leftOutOfMainWorkbook(definition, mode, input.lookupTarget),
	);
	const leftOutIds = new Set(leftOut.map((definition) => definition.id));
	const jsonLookupTables =
		mode === "hq-upload" && naming !== undefined
			? referenced.flatMap((definition) => {
					if (
						leftOutIds.has(definition.id) ||
						fixtureData.streamedTables?.has(definition.id)
					)
						return [];
					const table = naming.tables.find(
						(candidate) => candidate.tableId === definition.id,
					);
					return table !== undefined &&
						travelsAsJson(
							definition,
							table,
							fixtureData.rowsByTable.get(definition.id) ?? [],
							input.jsonDestinationTableIds?.has(definition.id) ?? false,
							input.workbookLookupTags?.get(definition.id)?.has(table.tag) ??
								false,
						)
						? [table]
						: [];
				})
			: [];
	const jsonIds = new Set<string>(
		jsonLookupTables.map((table) => table.tableId),
	);
	const mainDefinitions = referenced.filter(
		(definition) =>
			!leftOutIds.has(definition.id) &&
			!jsonIds.has(definition.id) &&
			!fixtureData.streamedTables?.has(definition.id),
	);
	/* Each HQ workbook's tables, judged and built over its own: the main one,
	 * and for `hq-json` one of the tables each project space manages. A table
	 * no workbook carries is never sent, so CommCare HQ never trims it and its
	 * tag is never refused. */
	const managedOrigins = mode === "hq-json" ? groupByOrigin(leftOut) : [];
	const workbookTables =
		mode === "ccz"
			? []
			: [mainDefinitions, ...managedOrigins.map((group) => group.tables)].map(
					(definitions) =>
						definitions.length === 0
							? undefined
							: lookupWireNaming(definitions),
				);
	const sentDefinitions = mode === "hq-json" ? referenced : mainDefinitions;
	const textFindings = [
		...lookupXmlTextFindings(narrowSnapshot(fixtureData, referenced)),
		...(mode === "ccz"
			? []
			: lookupHqCellTextFindings(narrowSnapshot(fixtureData, sentDefinitions))),
	];
	const lookupWire =
		naming === undefined || mode !== "ccz" || textFindings.length > 0
			? undefined
			: {
					naming,
					fixtures: buildLookupFixtures(
						lookupWireNaming(referenced),
						new Map([
							...fixtureData.rowsByTable,
							...[...(fixtureData.streamedTables?.keys() ?? [])].map(
								(id) => [id, []] as const,
							),
						]),
					),
				};
	// Small workbooks use exactly the same representation check as a paged
	// workbook. A direct renderer must never throw or silently simplify a row.
	const alternatives: ValidationError[] = [];
	const alternativeKinds = new Map<string, string>();
	for (const group of workbookTables) {
		if (!group) continue;
		for (const table of group.tables) {
			const shape = lookupWorkbookShape(table);
			for (const row of fixtureData.rowsByTable.get(table.tableId) ?? [])
				observeLookupWorkbookRow(
					shape,
					table,
					row,
					input.assignments?.get(table.tableId)?.get(row.id),
				);
			if (!shape.issue) continue;
			const definition = fixtureData.definitions.find(
				(t) => t.id === table.tableId,
			);
			if (!definition)
				throw new Error("The planned workbook lost its table definition.");
			const carrier = alternativeLookupCarrier(definition, shape.issue);
			alternativeKinds.set(table.tableId, carrier.kind);
			/* A table tagged `types` is refused by its tag
			 * (`lookupHqReservedTagFindings`), whose ways out are a direct
			 * publish without a workbook and a new export tag. Neither is open
			 * to Nova's copy of a table CommCare HQ manages: Nova refuses every
			 * edit of it, and its indexes CommCare HQ never showed keep it off
			 * the JSON resources. Create a separate table is its way out, so
			 * that copy is named here, and its tag is not refused besides. */
			if (
				(table.tag.toLowerCase() === TYPES_SHEET &&
					!separableCopy(definition)) ||
				textFindings.some((f) => f.details?.tableId === table.tableId)
			)
				continue;
			alternatives.push(
				validationError(
					"LOOKUP_WORKER_SOURCE_UNAVAILABLE",
					"app",
					describeLookupCarrierAlternative(
						definition.name,
						carrier,
						/* On a direct upload a table the JSON resources could carry is
						 * in the workbook only because the Project put it there by
						 * one (`travelsAsJson`). */
						mode === "hq-json" ? "file" : "workbook-there",
					),
					{},
					{
						tableId: table.tableId,
						tableName: definition.name,
						delivery: carrier.kind,
						/* Nova's complete copy of a table another project space manages,
						 * stopped only by indexes CommCare HQ never showed: a separate
						 * Nova table made from it travels (`lib/deployment/separateTable.ts`). */
						...(separableCopy(definition) ? { separable: "yes" } : {}),
					},
				),
			);
		}
	}
	const [lookupWorkbook, ...managedWorkbooks] = workbookTables.map((tables) =>
		tables === undefined ||
		alternatives.length > 0 ||
		hasUnpushableTag(tables) ||
		textFindings.length > 0
			? undefined
			: buildLookupWorkbook(tables, fixtureData.rowsByTable, input.assignments),
	);
	const managedLookupWorkbooks = managedOrigins.flatMap((group, index) => {
		const workbook = managedWorkbooks[index];
		return workbook === undefined
			? []
			: [{ server: group.server, domain: group.domain, workbook }];
	});
	const rowFindings = [
		...alternatives,
		...lookupExportFindings(doc, {
			fixtureData: narrowSnapshot(
				fixtureData,
				referenced.filter((t) => !fixtureData.streamedTables?.has(t.id)),
			),
			textFindings,
			...(lookupWire !== undefined && { fixtures: lookupWire.fixtures }),
			hqNamings: workbookTables
				.filter((tables) => tables !== undefined)
				.map((naming) => ({
					...naming,
					tables: naming.tables.filter(
						(table) =>
							!alternatives.some(
								(finding) => finding.details?.tableId === table.tableId,
							),
					),
				})),
			workbooks: [lookupWorkbook, ...managedWorkbooks].filter(
				(workbook) => workbook !== undefined,
			),
		}),
		...organizationExportFindings(doc, mode),
	].map((finding) => {
		const kind =
			finding.details?.tableId && alternativeKinds.get(finding.details.tableId);
		return kind
			? { ...finding, details: { ...finding.details, delivery: kind } }
			: finding;
	});
	let selectionFindings: readonly ValidationError[] | undefined;
	return {
		naming,
		lookupWire,
		lookupWorkbook,
		managedLookupTables: (mode === "hq-json"
			? fixtureData.definitions.filter((table) =>
					leftOutOfMainWorkbook(table, mode, undefined),
				)
			: leftOut
		).map(managedLookupTable),
		managedLookupWorkbooks,
		jsonLookupTables,
		rowFindings,
		get selectionFindings() {
			selectionFindings ??=
				mode === "ccz" ? [] : hqNestedSelectionFindings(doc, mode, naming);
			return selectionFindings;
		},
	};
}

/**
 * Whether a direct upload carries this table through CommCare HQ's JSON
 * resources instead of the workbook: only a table those resources carry
 * whole (`lib/commcare/lookup/carrier.ts::alternativeLookupCarrier`: global,
 * no index, a complete copy where it has a source), and only where the
 * workbook cannot carry its rows exactly (`lookupWorkbookShape`: the tag
 * `types`, a value CommCare HQ's reader would trim, an occurrence count or
 * an empty occurrence it would lose) or the table already has a JSON
 * destination there, whose rows a workbook would replace. A table the
 * Project already put there under its tag by a workbook stays in the
 * workbook: its rows there carry no Nova identity the JSON resources could
 * reconcile by.
 */
function travelsAsJson(
	definition: LookupTableDefinition,
	table: LookupTableWireNaming,
	rows: readonly LookupFixtureRow[],
	hasDestination: boolean,
	inWorkbookThere: boolean,
): boolean {
	if (alternativeLookupCarrier(definition, "").kind !== "json") return false;
	if (hasDestination) return true;
	if (inWorkbookThere) return false;
	const shape = lookupWorkbookShape(table);
	for (const row of rows) {
		if (shape.issue !== undefined) break;
		observeLookupWorkbookRow(shape, table, row);
	}
	return shape.issue !== undefined;
}

/**
 * Whether the mode leaves a table out of its main workbook. A direct upload
 * leaves out a table CommCare HQ manages in exactly the project space it
 * writes to: CommCare HQ's fixture upload leaves a table it is not sent
 * alone (`fixtures/upload/run_upload.py::_run_upload`), so leaving it out is
 * the whole of never writing it. A managed table of another project space
 * stays in, and the upload makes it there from Nova's copy. The HQ app file
 * is made for no project space, so it moves every table CommCare HQ manages
 * to a workbook of the project space that manages it, which a person
 * importing into that space leaves out.
 */
function leftOutOfMainWorkbook(
	definition: LookupTableDefinition,
	mode: ExportMode,
	target: LookupTarget | undefined,
): boolean {
	const hq = definition.hq;
	if (hq === undefined || hq.managedBy !== "commcare-hq") return false;
	switch (mode) {
		case "ccz":
			return false;
		case "hq-json":
			return true;
		case "hq-upload":
			return (
				target !== undefined &&
				hq.server === target.server &&
				hq.domain === target.domain
			);
	}
}

/** The managed tables grouped by the project space that manages them, in the order they first name each. */
function groupByOrigin(
	definitions: readonly LookupTableDefinition[],
): readonly {
	readonly server: string;
	readonly domain: string;
	readonly tables: readonly LookupTableDefinition[];
}[] {
	const groups = new Map<
		string,
		{ server: string; domain: string; tables: LookupTableDefinition[] }
	>();
	for (const definition of definitions) {
		const { server, domain } = managedLookupTable(definition);
		const key = `${server}\u0000${domain}`;
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, { server, domain, tables: [definition] });
		} else group.tables.push(definition);
	}
	return [...groups.values()];
}

function managedLookupTable(
	definition: LookupTableDefinition,
): ManagedLookupTable {
	const hq = definition.hq;
	if (hq === undefined)
		throw new Error(
			`The lookup table ${definition.tag} was left out of the workbook as one CommCare HQ manages, and it has no CommCare HQ origin. Only a table whose origin says CommCare HQ manages it is left out.`,
		);
	return {
		tableId: definition.id,
		tag: definition.tag,
		name: definition.name,
		server: hq.server,
		domain: hq.domain,
		refreshedAt: hq.refreshedAt,
	};
}

/** The snapshot's tables narrowed to `definitions`, with their rows. */
function narrowSnapshot(
	snapshot: LookupFixtureDataSnapshot,
	definitions: readonly LookupTableDefinition[],
): LookupFixtureDataSnapshot {
	if (definitions.length === snapshot.definitions.length) return snapshot;
	return {
		projectId: snapshot.projectId,
		projectRevision: snapshot.projectRevision,
		definitions,
		rowsByTable: new Map(
			definitions.flatMap((definition) => {
				const rows = snapshot.rowsByTable.get(definition.id);
				return rows === undefined ? [] : [[definition.id, rows] as const];
			}),
		),
	};
}

/**
 * The one owner term that cannot cross an export boundary.
 *
 * The fixture is not what decides this. `owner-location-at-level`
 * reads `instance('locations')`, and that is CommCare's own restore
 * fixture on every mode alike (`jr://fixture/locations`; Nova emits no
 * copy, and native compatibility scripts execute HQ's actual serializer).
 * `fixed-location` reads no instance: `xpath/wire/fromExpression.ts` builds
 * only a string literal for that arm.
 * What decides this is WHOSE IDENTITIES the printed expression carries.
 *
 * `owner-location-at-level` carries none of Nova's.
 * `xpath/wire/fromExpression.ts` prints level CODES, which a publish puts on
 * the project space as `location_type_code` and which are therefore the
 * same word on both sides, and matches them against the case's own
 * `owner_id`, which is CommCare HQ's value at runtime. Every part of that
 * expression means the same thing over there, so it exports.
 *
 * What that expression DOES assume is four things about the target
 * project space, none of which Nova can see from here. A publish to a space
 * Nova pushed makes three of them true and asks the person about the
 * fourth. Each is stated because it
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
 *   * **It sends its flat location list.** Every app carries
 *     `project_default`, so `locations/fixtures.py::should_sync_flat_fixture`
 *     asks the project space's `LocationFixtureConfiguration.sync_flat_fixture`,
 *     which is on unless someone turned it off. A publish asks the person to
 *     confirm it; a `.ccz` or import file cannot.
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
 * A publish settles three and asks about the fourth, and none is a reason to refuse an export:
 * they are the name-and-shape agreement every code-based binding Nova
 * emits already rests on, case types included, and refusing because a
 * target MIGHT disagree would refuse far more than this. What is left
 * unproved is the two modes that have no target to ask — and they are
 * named here rather than left to be noticed, because the first and fourth
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
	mode: ExportMode,
): ValidationError[] {
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
	readonly textFindings: readonly ValidationError[];
	/** Built for `ccz` only: the bytes the archive would embed. */
	readonly fixtures?: CompiledLookupFixtureSet;
	/**
	 * The current wire identities of each HQ workbook's tables, on the two
	 * HQ modes only, and only of tables a workbook carries. Read for the
	 * checks that are about a NAME rather than about bytes, which must
	 * therefore run even when a workbook could not be built.
	 */
	readonly hqNamings: readonly LookupWireNaming[];
	/** Built for the two HQ modes only: each workbook's bytes CommCare HQ would read. */
	readonly workbooks: readonly LookupWorkbook[];
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
	lookupRows: LookupRowVerdictInput,
): ValidationError[] {
	// Administrator-assignment workbooks carry every intended row. Their union
	// cannot attest a worker's choices, including duplicates visible only to
	// disjoint principals. Source/reference-only paths carry no private rows.
	const snapshot = lookupRows.fixtureData;
	const privateIds = new Set(
		snapshot.definitions
			.filter(
				(t) =>
					t.workerAccess === "assigned" ||
					t.hq?.source?.distribution === "assigned",
			)
			.map((t) => t.id),
	);
	const workerSnapshot = privateIds.size
		? {
				...snapshot,
				rowsByTable: new Map(
					[...snapshot.rowsByTable].filter(([id]) => !privateIds.has(id)),
				),
			}
		: snapshot;
	return [
		...lookupRows.textFindings,
		...lookupSelectSourceRowFindings(doc, workerSnapshot),
		...(lookupRows.fixtures === undefined
			? []
			: lookupFixtureBudgetFindings(lookupRows.fixtures)),
		...lookupRows.hqNamings.flatMap(lookupHqReservedTagFindings),
		...lookupRows.workbooks.flatMap(lookupWorkbookBudgetFindings),
	];
}

/**
 * Whether any referenced tag is `types`, the one name a data sheet cannot
 * take.
 *
 * Read before the workbook is built, because the builder cannot name a
 * sheet it has no legal name for; the boundary refuses first so the
 * emitter stays total.
 */
function hasUnpushableTag(naming: LookupWireNaming): boolean {
	return naming.tables.some((table) => table.tag.toLowerCase() === TYPES_SHEET);
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
				`CommCare HQ keeps the sheet name ${TYPES_SHEET} for its own list of the tables in a workbook, so the export tag ${table.tag} has nowhere to put its rows there. A direct publish to CommCare HQ from Nova carries a table with no index and no row assignments under that tag without a workbook. Otherwise you can rename the tag in Project data, then try again.`,
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

/** Whether Create a separate table makes a table a workbook can carry from `table`. */
function separableCopy(table: LookupTableDefinition): boolean {
	const source = table.hq?.source;
	return (
		table.hq?.managedBy === "commcare-hq" &&
		table.workerAccess !== "assigned" &&
		source?.distribution !== "assigned" &&
		source?.storage !== "generation" &&
		(source === undefined || source.inventory === "complete") &&
		table.columns.some((column) => column.index === "unobserved")
	);
}

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
