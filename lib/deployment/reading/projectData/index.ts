/**
 * The project data of one reading of a CommCare HQ app: the lookup tables it
 * may read, the levels and places of its project space, and what is decided
 * of each. `read.ts` gathers it; this file judges it once the reader has run,
 * since a table matters only where the app reads it and the levels and places
 * only where the app reads places.
 *
 * Pure: every function takes what was gathered and what the reader read, and
 * reaches no store.
 */

import type { HqFailure } from "@/lib/commcare/hq/failure";
import type { HqLocation, HqLocationType } from "@/lib/commcare/hq/locations";
import { lookupSelectSourceRowFindings } from "@/lib/commcare/lookup/selectSourceRows";
import { lookupXmlTextFindings } from "@/lib/commcare/lookup/xmlText";
import type { IdentityResolver } from "@/lib/commcare/reader/identity";
import type {
	ReaderLookupCatalog,
	ReaderOrganization,
	ReadOutcome,
} from "@/lib/commcare/reader/types";
import { levelsFromHq } from "@/lib/commcare/reader/worldEntities";
import { xmlTextIssue } from "@/lib/commcare/xmlText";
import {
	collectLookupOptionsSourceCarriers,
	extractLookupReferenceTargets,
} from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, orderedLocationProperties } from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupRowsMeasure } from "@/lib/lookup/managedRules";
import type {
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
	LookupReferencingAppSummary,
	LookupRevision,
	LookupRowValues,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import type { ManagedPlacePlan } from "@/lib/organization/managed";
import {
	circumstanceFinding,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import type { SiblingLookupMapping } from "../../store";
import { manifestFinding } from "./findings";
import { broughtInLookupColumnId } from "./lookupIds";
import {
	type BroughtInTableWrite,
	boundAsItStands,
	type HqLookupTableRead,
	type LookupTableBinding,
	type LookupTableStanding,
	lookupFixtureBudgetFinding,
	lookupTableFindings,
	lookupTableStanding,
	readerLookupCatalog,
	readingLookupSnapshot,
	resolveLookupBindings,
	sameManagedColumnCapFinding,
} from "./lookupTables";
import {
	documentReadsPlaces,
	managedPlacesOwnerFindings,
	placesOverNovaLimitFinding,
	planManagedPlaces,
} from "./places";
import type { LookupTableChoice } from "./reviewTypes";

export { resolveTableChoices } from "./lookupTables";
export {
	LOOKUP_TABLE_CHOICES,
	type LookupChoiceOffer,
	type LookupTableChoice,
} from "./reviewTypes";

/** The Project table a tag met, at the revisions the read saw. */
export interface MetProjectTable {
	readonly tableId: LookupTableId;
	readonly definitionRevision: string;
	readonly rowsRevision: string;
}

/** One candidate table of a reading, and what was decided of it. */
export interface ReadingLookupTable {
	readonly read: HqLookupTableRead;
	/** What Nova cannot hold of the table, raised only if the reader reads it. */
	readonly findings: readonly Finding[];
	/** Null where the table cannot come in. */
	readonly standing: LookupTableStanding | null;
	readonly binding: LookupTableBinding | null;
	/** The answer the binding stands under: null as the read returns it, and for a tag that asks
	 *  none. `underTableChoices` sets it. */
	readonly choice: LookupTableChoice | null;
	/** The Project table the tag met, at the revisions the read saw; null where none. */
	readonly projectTable: MetProjectTable | null;
}

export interface ReadingProjectData {
	/** The reader's catalog over the bindings. */
	readonly lookups: ReaderLookupCatalog;
	/** CommCare HQ's levels and their codes, both empty where no place was read. */
	readonly organization: ReaderOrganization;
	/** Whether the levels and places were read. */
	readonly placesRead: boolean;
	/**
	 * The failed read of the levels and places, where only the source's text
	 * asked for them: null where they were read or never asked for. Such a read
	 * ends a reading only as `unreadPlacesFailure` says, since the text's test
	 * can say yes where nothing reads places.
	 */
	readonly placesUnread: HqFailure | null;
	/** Everything read and decided, for the functions below. Held in memory for one request. */
	readonly gathered: {
		readonly origin: { readonly server: string; readonly domain: string };
		/** The two ids every lookup id of this reading derives from. */
		readonly appId: string;
		readonly readingId: string;
		readonly tables: readonly ReadingLookupTable[];
		/** The Project's answers, kept whole: the snapshot and the review read them. */
		readonly project: {
			readonly projectId: string;
			readonly projectRevision: LookupRevision;
			/** The rows of each Project table a candidate's tag met, by the table's id. */
			readonly rowsByTable: Readonly<
				Record<string, readonly LookupFixtureRow[]>
			>;
			/** The apps that read each of those tables, by the table's id. */
			readonly apps: Readonly<
				Record<string, readonly LookupReferencingAppSummary[]>
			>;
			/** The columns of each of those tables CommCare HQ's content keeps, by the table's id. */
			readonly keptColumns: Readonly<Record<string, readonly string[]>>;
			readonly siblings: readonly SiblingLookupMapping[];
			readonly mayAdminister: boolean;
		};
		/** Tags of CommCare HQ's list, to tell a table that is not there from one Nova cannot hold. */
		readonly hqTags: readonly string[];
		readonly hqLevels: readonly HqLocationType[];
		readonly hqPlaces: readonly HqLocation[];
		/** Set where the place list stopped past Nova's limit: CommCare HQ's total, or null where
		 *  no page named one. `hqPlaces` is then empty. */
		readonly placesPastLimit: { readonly totalCount: number | null } | null;
	};
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/** What the Project holds of the candidates' tags, as the read's step 3 answered. */
export interface ReadingProjectAnswers {
	readonly projectId: string;
	readonly projectRevision: LookupRevision;
	/** The Project's tables whose tag is a candidate's, each with its revisions. */
	readonly definitions: readonly LookupTableDefinition[];
	readonly rowsByTable: Readonly<Record<string, readonly LookupFixtureRow[]>>;
	readonly apps: Readonly<
		Record<string, readonly LookupReferencingAppSummary[]>
	>;
	/**
	 * By table id, the ids of the columns an app's reference edge names or an
	 * accepted design protects, which CommCare HQ's content keeps where its
	 * fields lack them (`readKeptLookupColumnIds`); a table absent keeps none.
	 */
	readonly keptColumns: Readonly<Record<string, readonly string[]>>;
	readonly siblings: readonly SiblingLookupMapping[];
	readonly mayAdminister: boolean;
}

/** The levels and places CommCare HQ answered, or null where they were not read. */
export interface ReadingPlacesRead {
	readonly hqLevels: readonly HqLocationType[];
	readonly hqPlaces: readonly HqLocation[];
	readonly placesPastLimit: { readonly totalCount: number | null } | null;
}

/** Code-unit order: the same answer on every machine, unlike a locale's. */
function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The rows of a candidate as a table of its tag would store them, keyed by the
 * column ids derived for its fields, for Postgres to measure; null where the
 * rows have no stored form to measure: a read with no rows, a field with other
 * than one value, or a cell XML cannot carry (which Postgres cannot store
 * either), each already a finding of the table. Pure.
 */
export function rowsToMeasure(
	read: HqLookupTableRead,
	ids: { readonly appId: string; readonly readingId: string },
): readonly LookupRowValues[] | null {
	if (read.kind !== "read") return null;
	const tag = read.table.tag;
	const values: LookupRowValues[] = [];
	for (const row of read.rows) {
		const stored: LookupRowValues = {};
		for (const field of read.table.fields) {
			if (!Object.hasOwn(row.fields, field)) continue;
			const value = row.fields[field];
			if (typeof value !== "string") return null;
			if (xmlTextIssue(value) !== undefined) return null;
			stored[broughtInLookupColumnId(ids.appId, ids.readingId, tag, field)] =
				value;
		}
		values.push(stored);
	}
	return values;
}

/** The Project table's two revisions, as the read saw them. */
function metProjectTable(table: LookupTableDefinition): MetProjectTable {
	if (table.rowsRevision === undefined) {
		throw new Error(
			`The Project's lookup table ${table.tag} was read without its rows revision.`,
		);
	}
	return {
		tableId: table.id,
		definitionRevision: table.definitionRevision,
		rowsRevision: table.rowsRevision,
	};
}

/** The reader's catalog over every bound table, each as its binding and answer say. */
function catalogOf(tables: readonly ReadingLookupTable[]): ReaderLookupCatalog {
	return readerLookupCatalog(
		tables.flatMap((table) => {
			const { read, standing, binding } = table;
			if (standing === null || binding === null || read.kind !== "read") {
				return [];
			}
			return [
				{
					binding,
					name: standing.kind === "new" ? read.table.tag : standing.table.name,
					fields: read.table.fields,
					...(boundAsItStands(standing, table.choice)
						? { asItStands: standing.table }
						: {}),
				},
			];
		}),
	);
}

/**
 * Everything a read gathered, decided: per candidate, what Nova cannot hold
 * of it (`lookupTableFindings` over `measured`, by tag); where there is
 * nothing, its standing against the Project's table of its tag, judged with
 * no field read, since a standing's kind reads none; and its binding with no
 * answer. Then the reader's catalog over the bindings, and the levels and
 * places as they were read. Pure.
 */
export function assembleReadingProjectData(input: {
	readonly origin: { readonly server: string; readonly domain: string };
	readonly appId: string;
	readonly readingId: string;
	readonly tables: readonly HqLookupTableRead[];
	readonly hqTags: readonly string[];
	readonly project: ReadingProjectAnswers;
	/** Postgres's measure of each candidate's rows, by tag; absent or null where not measured. */
	readonly measured: ReadonlyMap<string, LookupRowsMeasure | null>;
	readonly places: ReadingPlacesRead | null;
	/** The failed read of the levels and places the source's text alone asked for. */
	readonly placesUnread: HqFailure | null;
}): ReadingProjectData {
	const { origin, project } = input;
	const ids = { appId: input.appId, readingId: input.readingId };
	const byTag = new Map(
		project.definitions.map((definition) => [definition.tag, definition]),
	);
	const tables = input.tables.map((read): ReadingLookupTable => {
		const tag = read.table.tag;
		const existing = byTag.get(tag) ?? null;
		const projectTable = existing === null ? null : metProjectTable(existing);
		const measured = input.measured.get(tag) ?? null;
		const findings = lookupTableFindings(read, measured);
		if (findings.length > 0 || read.kind !== "read") {
			return {
				read,
				findings,
				standing: null,
				binding: null,
				choice: null,
				projectTable,
			};
		}
		const keptColumnIds =
			existing === null ? [] : keptColumnsOf(project.keptColumns, existing);
		const standing = lookupTableStanding({
			read,
			origin,
			existing:
				existing === null
					? null
					: { table: existing, rows: rowsOf(project.rowsByTable, existing) },
			apps:
				existing === null
					? []
					: Object.hasOwn(project.apps, existing.id)
						? project.apps[existing.id]
						: [],
			siblings:
				existing === null
					? []
					: project.siblings.filter(
							(sibling) => sibling.tableId === existing.id,
						),
			appReads: [],
			mayAdminister: project.mayAdminister,
			keptColumnIds,
		});
		const capFinding = sameManagedColumnCapFinding(
			read,
			standing,
			keptColumnIds,
		);
		if (capFinding !== null) {
			return {
				read,
				findings: [capFinding],
				standing: null,
				binding: null,
				choice: null,
				projectTable,
			};
		}
		const [binding] = resolveLookupBindings(
			[read],
			{ [tag]: standing },
			null,
			ids,
		);
		return {
			read,
			findings,
			standing,
			binding,
			choice: null,
			projectTable,
		};
	});
	const places = input.places;
	return {
		lookups: catalogOf(tables),
		organization: {
			levelCodes: (places?.hqLevels ?? []).map((level) => level.code),
			levels: places?.hqLevels ?? [],
		},
		placesRead: places !== null,
		placesUnread: places === null ? input.placesUnread : null,
		gathered: {
			origin,
			appId: input.appId,
			readingId: input.readingId,
			tables,
			project: {
				projectId: project.projectId,
				projectRevision: project.projectRevision,
				rowsByTable: project.rowsByTable,
				apps: project.apps,
				keptColumns: project.keptColumns,
				siblings: project.siblings,
				mayAdminister: project.mayAdminister,
			},
			hqTags: input.hqTags,
			hqLevels: places?.hqLevels ?? [],
			hqPlaces: places?.hqPlaces ?? [],
			placesPastLimit: places?.placesPastLimit ?? null,
		},
	};
}

/** The kept columns of a Project table, none where the read named none. */
export function keptColumnsOf(
	keptColumns: Readonly<Record<string, readonly string[]>>,
	table: LookupTableDefinition,
): readonly string[] {
	return Object.hasOwn(keptColumns, table.id) ? keptColumns[table.id] : [];
}

function rowsOf(
	rowsByTable: Readonly<Record<string, readonly LookupFixtureRow[]>>,
	table: LookupTableDefinition,
): readonly LookupFixtureRow[] {
	if (!Object.hasOwn(rowsByTable, table.id)) {
		throw new Error(
			`The Project's lookup table ${table.tag} was read without its rows.`,
		);
	}
	return rowsByTable[table.id];
}

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

/**
 * The same data with each answered `choice` tag bound as its answer says: the
 * bindings resolved again with the answers, each answered table's `choice`
 * set, and the catalog over the result. Nothing else changes, and no answer
 * moves a binding the reader read. An answer for a tag that asks no choice
 * is a caller's mistake (`resolveTableChoices` names those) and throws. Pure.
 */
export function underTableChoices(
	data: ReadingProjectData,
	choices: Readonly<Record<string, LookupTableChoice>>,
): ReadingProjectData {
	const ids = {
		appId: data.gathered.appId,
		readingId: data.gathered.readingId,
	};
	const asks = new Set(
		data.gathered.tables
			.filter((table) => table.standing?.kind === "choice")
			.map((table) => table.read.table.tag),
	);
	for (const tag of Object.keys(choices)) {
		if (!asks.has(tag)) {
			throw new Error(
				`An answer was given for the lookup table ${tag}, which asks no choice.`,
			);
		}
	}
	const tables = data.gathered.tables.map((table): ReadingLookupTable => {
		const tag = table.read.table.tag;
		if (
			!Object.hasOwn(choices, tag) ||
			table.standing?.kind !== "choice" ||
			table.read.kind !== "read"
		) {
			return table;
		}
		const [binding] = resolveLookupBindings(
			[table.read],
			{ [tag]: table.standing },
			choices,
			ids,
		);
		return { ...table, binding, choice: choices[tag] };
	});
	return {
		...data,
		lookups: catalogOf(tables),
		gathered: { ...data.gathered, tables },
	};
}

// ---------------------------------------------------------------------------
// What the reader read
// ---------------------------------------------------------------------------

/** What the reader read of project data. */
export interface ReaderProjectDataReads {
	/** Field names read, by the tag of each table the document binds. */
	readonly lookupFields: Readonly<Record<string, readonly string[]>>;
	/** Tags read that the catalog does not hold (`ReadFacts.unreadTables`). */
	readonly unreadTables: readonly string[];
	readonly readsPlaces: boolean;
}

/**
 * What the reader read of project data. A `read` names the tables its
 * document reads through the bindings, with the fields of each, the tags it
 * read that the catalog lacks, and whether the document reads places. An
 * `account` holds no document: it carries the tags it read that the catalog
 * lacks and whether it reads places itself, and no table it read is bound.
 * Pure.
 */
export function projectDataReadsOf(
	data: ReadingProjectData,
	outcome: ReadOutcome,
): ReaderProjectDataReads {
	if (outcome.kind === "account") {
		return {
			lookupFields: {},
			unreadTables: distinctTags(outcome.unreadTables),
			readsPlaces: outcome.readsLocations,
		};
	}
	const { doc, facts } = outcome.draft;
	const bindings = new Map<LookupTableId, LookupTableBinding>();
	for (const table of data.gathered.tables) {
		if (table.binding !== null) {
			bindings.set(table.binding.tableId, table.binding);
		}
	}
	const targets = extractLookupReferenceTargets(doc);
	const fields = new Map<string, Set<string>>();
	const bindingOf = (tableId: LookupTableId): LookupTableBinding => {
		const binding = bindings.get(tableId);
		if (binding === undefined) {
			throw new Error(
				`A reading's document reads the lookup table ${tableId}, which no binding names.`,
			);
		}
		return binding;
	};
	for (const tableId of targets.tableIds) {
		const binding = bindingOf(tableId);
		if (!fields.has(binding.tag)) fields.set(binding.tag, new Set());
	}
	for (const target of targets.columnTargets) {
		const binding = bindingOf(target.tableId);
		const field = Object.entries(binding.columns).find(
			([, columnId]) => columnId === target.columnId,
		)?.[0];
		if (field === undefined) {
			throw new Error(
				`A reading's document reads a column of the lookup table ${binding.tag} that its binding does not name.`,
			);
		}
		const set = fields.get(binding.tag) ?? new Set<string>();
		set.add(field);
		fields.set(binding.tag, set);
	}
	return {
		lookupFields: Object.fromEntries(
			[...fields.entries()]
				.sort(([left], [right]) => compareCodeUnits(left, right))
				.map(([tag, read]) => [tag, [...read].sort(compareCodeUnits)]),
		),
		unreadTables: distinctTags(facts.unreadTables),
		readsPlaces: documentReadsPlaces(doc),
	};
}

/**
 * The failed read of the levels and places a reading ends with, or null.
 * `placesUnread` ends it where the reader's document reads places, and
 * wherever the reader refused something (an `account`): the reader ran
 * without CommCare HQ's levels, so a read of a place at a level names a
 * level it does not hold and is refused as an expression no runtime can
 * evaluate as its author meant, which no bound tree then shows as a read of
 * places. Such an account would name a permission as a broken app; asking
 * for the permission first leaves only refusals that are the app's own.
 * Only a document the reader read whole, with no refusal, says the app
 * reads no place, and then the failure is dropped. Pure.
 */
export function unreadPlacesFailure(
	data: ReadingProjectData,
	outcome: ReadOutcome,
): HqFailure | null {
	if (data.placesUnread === null) return null;
	if (outcome.kind === "account") return data.placesUnread;
	return documentReadsPlaces(outcome.draft.doc) ? data.placesUnread : null;
}

function distinctTags(
	unread: readonly { readonly tag: string }[],
): readonly string[] {
	return [...new Set(unread.map((table) => table.tag))].sort(compareCodeUnits);
}

// ---------------------------------------------------------------------------
// The findings
// ---------------------------------------------------------------------------

/** A read of a table the project space's list does not hold: an expression no runtime can evaluate as its author meant. */
const MISSING_TABLE_ENTRY =
	"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant";

/**
 * Every finding of project data for this read. `doc` is null where the reader
 * gave an account.
 *
 * For each tag the reader read, bound or not: the table's own findings, or,
 * where CommCare HQ's list lacks the tag, a read of a table that is not
 * there. Then, over the tables the document reads as the birth will hold
 * them (`readingLookupSnapshot`): a cell XML cannot carry, the tables
 * together over what one `.ccz` carries, and, with a document, one
 * `table-choices-unusable` a table whose rows cannot be the choices of a
 * question or search field that reads them. Where the app reads places:
 * `places-over-nova-limit` alone where the list stopped past Nova's limit;
 * otherwise the levels Nova cannot hold, the places it cannot, and, with a
 * document, an owner rule the copy would refuse. A value of a place is judged
 * only with a document, once the rest of the app can come in.
 *
 * `resolver` is this call's own: `levelsFromHq` claims each level's key, and a
 * resolver answers a key once.
 */
export function readingProjectDataFindingsFor(
	data: ReadingProjectData,
	reads: ReaderProjectDataReads,
	doc: BlueprintDoc | null,
	resolver: IdentityResolver,
): readonly Finding[] {
	const findings: Finding[] = [];
	const listed = new Set(data.gathered.hqTags);
	const byTag = new Map(
		data.gathered.tables.map((table) => [table.read.table.tag, table]),
	);
	const tags = [
		...new Set([...Object.keys(reads.lookupFields), ...reads.unreadTables]),
	].sort(compareCodeUnits);
	for (const tag of tags) {
		if (!listed.has(tag)) {
			findings.push(
				manifestFinding(
					MISSING_TABLE_ENTRY,
					{ kind: "lookup-table", tag },
					tag,
				),
			);
			continue;
		}
		const table = byTag.get(tag);
		if (table !== undefined) findings.push(...table.findings);
	}

	const snapshot = readingLookupSnapshot(data, reads);
	const unrepresentable = unrepresentableCellFindings(snapshot);
	findings.push(...unrepresentable);
	// No fixture holds a cell XML cannot carry, so the tables are measured
	// together only once every cell can be written, as the export does.
	const budget =
		unrepresentable.length === 0 ? lookupFixtureBudgetFinding(snapshot) : null;
	if (budget !== null) findings.push(budget);
	if (doc !== null) findings.push(...tableChoicesUnusable(doc, snapshot));

	if (reads.readsPlaces) {
		const { placesPastLimit } = data.gathered;
		if (placesPastLimit !== null) {
			findings.push(placesOverNovaLimitFinding(placesPastLimit.totalCount));
		} else {
			const levels = levelsFromHq(data.gathered.hqLevels, resolver);
			const plan = planManagedPlaces({
				hqPlaces: data.gathered.hqPlaces,
				levels: levels.levels,
				properties: doc === null ? [] : orderedLocationProperties(doc),
				mode: "birth",
			});
			findings.push(...levels.findings, ...plan.findings);
			if (doc !== null) findings.push(...managedPlacesOwnerFindings(doc, plan));
		}
	}
	return findings;
}

/** `"<tag> (the field <field name>)"`. */
function fieldName(tag: string, wireName: string): string {
	return `${tag} (the field ${wireName})`;
}

/** One `table-cell-unrepresentable` per field of the snapshot holding a cell XML cannot carry. */
function unrepresentableCellFindings(
	snapshot: LookupFixtureDataSnapshot,
): readonly Finding[] {
	const byId = new Map(
		snapshot.definitions.map((definition) => [definition.id, definition]),
	);
	return lookupXmlTextFindings(snapshot).map((error) => {
		const table = byId.get(error.details?.tableId as LookupTableId);
		const column = table?.columns.find(
			(candidate) => candidate.id === error.details?.columnId,
		);
		if (table === undefined || column === undefined) {
			throw new Error(
				"A lookup cell finding named a table or column its snapshot lacks.",
			);
		}
		const place: HqPlace = { kind: "lookup-table", tag: table.tag };
		return circumstanceFinding("table-cell-unrepresentable", place, {
			name: fieldName(table.tag, column.wireName),
		});
	});
}

/**
 * One `table-choices-unusable` per table whose rows cannot be the choices of
 * a question or search field that reads them, however many read it and
 * however many rules it fails, named by the column the table's first error
 * names, or, for a table with no rows, by the value column of the first
 * question or search field that takes its choices from it.
 */
function tableChoicesUnusable(
	doc: BlueprintDoc,
	snapshot: LookupFixtureDataSnapshot,
): readonly Finding[] {
	const byId = new Map(
		snapshot.definitions.map((definition) => [definition.id, definition]),
	);
	const carriers = collectLookupOptionsSourceCarriers(doc);
	const named = new Set<string>();
	const findings: Finding[] = [];
	for (const error of lookupSelectSourceRowFindings(doc, snapshot)) {
		const tableId = error.details?.tableId as LookupTableId;
		if (named.has(tableId)) continue;
		named.add(tableId);
		const table = byId.get(tableId);
		if (table === undefined) {
			throw new Error("A choices finding named a table its snapshot lacks.");
		}
		const columnId =
			error.details?.columnId ??
			carriers.find((carrier) => carrier.source.tableId === tableId)?.source
				.valueColumnId;
		const column = table.columns.find((candidate) => candidate.id === columnId);
		if (column === undefined) {
			throw new Error(
				`A choices finding of the lookup table ${table.tag} named no column it holds.`,
			);
		}
		findings.push(
			circumstanceFinding(
				"table-choices-unusable",
				{ kind: "lookup-table", tag: table.tag },
				{ name: fieldName(table.tag, column.wireName) },
			),
		);
	}
	return findings;
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

export interface ReadingProjectDataWrite {
	readonly origin: { readonly server: string; readonly domain: string };
	readonly tables: readonly BroughtInTableWrite[];
	readonly places: ManagedPlacePlan | null;
}

/**
 * What the birth writes of project data, from the data under the person's
 * answers: one table write per table the document reads, and, where it reads
 * places, the plan of Nova's copy of them over CommCare HQ's levels and the
 * document's location properties. Called on a read with no finding, so a
 * table it cannot bind, a `choice` with no answer, or places that cannot come
 * in is a caller's mistake and throws. `resolver` is this call's own. Pure.
 */
export function readingProjectDataWrite(
	data: ReadingProjectData,
	reads: ReaderProjectDataReads,
	doc: BlueprintDoc,
	resolver: IdentityResolver,
): ReadingProjectDataWrite {
	const byTag = new Map(
		data.gathered.tables.map((table) => [table.read.table.tag, table]),
	);
	const tables = Object.keys(reads.lookupFields)
		.sort(compareCodeUnits)
		.map((tag): BroughtInTableWrite => {
			const table = byTag.get(tag);
			if (
				table === undefined ||
				table.read.kind !== "read" ||
				table.standing === null ||
				table.binding === null
			) {
				throw new Error(
					`The document reads the lookup table ${tag}, which cannot come in.`,
				);
			}
			if (table.standing.kind === "choice" && table.choice === null) {
				throw new Error(
					`The lookup table ${tag} reached the write with no answer to its choice.`,
				);
			}
			return {
				read: table.read,
				standing: table.standing,
				choice: table.choice,
				binding: table.binding,
				projectTable: table.projectTable,
			};
		});
	return {
		origin: data.gathered.origin,
		tables,
		places: reads.readsPlaces ? bornPlaces(data, doc, resolver) : null,
	};
}

/**
 * The plan of Nova's copy of CommCare HQ's places at a birth, over the levels
 * the reading brings and the document's location properties. Places that were
 * not read, a list past Nova's limit and a plan with a finding cannot come in,
 * and throw.
 */
export function bornPlaces(
	data: ReadingProjectData,
	doc: BlueprintDoc,
	resolver: IdentityResolver,
): ManagedPlacePlan {
	if (!data.placesRead) {
		throw new Error(
			"The app reads places, and the reading never read CommCare HQ's.",
		);
	}
	if (data.gathered.placesPastLimit !== null) {
		throw new Error(
			"The app reads places, and CommCare HQ holds more than Nova keeps.",
		);
	}
	const plan = planManagedPlaces({
		hqPlaces: data.gathered.hqPlaces,
		levels: levelsFromHq(data.gathered.hqLevels, resolver).levels,
		properties: orderedLocationProperties(doc),
		mode: "birth",
	});
	if (plan.findings.length > 0) {
		throw new Error(
			"The app reads places, and CommCare HQ holds places Nova cannot hold.",
		);
	}
	return plan;
}

export { readingLookupSnapshot } from "./lookupTables";
