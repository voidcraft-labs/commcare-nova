import { lookupLexicalSlots } from "@/lib/commcare/lookup/lexicalSlots";
import { resolveLookupRead } from "@/lib/commcare/lookup/read";
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
import {
	claimsUnder,
	type IdentityResolver,
} from "@/lib/commcare/reader/identity";
import type {
	ReaderLookupCatalog,
	ReaderOrganization,
	ReadOutcome,
	UnreadTable,
} from "@/lib/commcare/reader/types";
import { levelsFromHq } from "@/lib/commcare/reader/worldEntities";
import { xmlTextIssue } from "@/lib/commcare/xmlText";
import {
	collectLookupOptionsSourceCarriers,
	extractLookupReferenceTargets,
} from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, orderedLocationProperties } from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	NO_ENTRIES,
	ownRecordValue,
	recordFromEntries,
} from "@/lib/domain/records";
import {
	type LookupRowsMeasure,
	lookupCapExcess,
} from "@/lib/lookup/managedRules";

import type {
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
	LookupReferencingAppSummary,
	LookupRevision,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import type { ManagedPlacePlan } from "@/lib/organization/managed";
import {
	circumstanceFinding,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import { canonicalLookupTable } from "../../hqResourceBaseline";
import type { SiblingLookupMapping } from "../../store";
import { manifestFinding } from "./findings";

import {
	type BroughtInTableWrite,
	boundAsItStands,
	boundSourceFixture,
	type HqLookupTableRead,
	type LookupTableBinding,
	type LookupTableStanding,
	lookupBindingNames,
	lookupFixtureBudgetFinding,
	lookupSourceFieldDetails,
	lookupTableFindings,
	lookupTableStanding,
	managedLookupContentOf,
	needsWorkerRows,
	provisionalLookupBinding,
	readerLookupCatalog,
	readingLookupSnapshot,
	resolveLookupBindings,
	sameManagedColumnCapFinding,
} from "./lookupTables";
import {
	documentReadsPlaces,
	managedPlacesOwnerFindings,
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
	readonly suiteDetails?: import("@/lib/commcare/reader/types").ReaderInput["suiteDetails"];
	readonly sourceProjectFactories?: import("@/lib/commcare/reader/types").ReaderInput["sourceProjectFactories"];
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
		/** When the read of CommCare HQ's lookup tables began: the date a birth's write
		 *  stamps on each table it takes CommCare HQ's content into, and the date no
		 *  refresh since may pass. */
		readonly tablesReadAt: Date;
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
		 *  the list passed its byte bound. `hqPlaces` is then empty. */
		readonly inconsistent?: boolean;
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
	readonly inconsistent?: boolean;
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
): readonly LookupFixtureRow[] | null {
	if (read.kind !== "read") return null;
	const hasInvalidText = (text: string) => xmlTextIssue(text) !== undefined;
	if (
		read.rows.some(
			(row) =>
				Object.values(row.itemAttributes ?? {}).some(hasInvalidText) ||
				Object.values(row.fields).some((field) =>
					typeof field === "string"
						? hasInvalidText(field)
						: field.some(
								(item) =>
									hasInvalidText(item.value) ||
									Object.values(item.properties).some(hasInvalidText),
							),
				),
		)
	)
		return null;
	return boundSourceFixture(
		read.table,
		read.rows,
		provisionalLookupBinding(read.table, ids),
	).rows;
}

/** The Project table's two revisions, as the read saw them. */
function metProjectTable(table: LookupTableDefinition): MetProjectTable {
	if (table.rowsRevision === undefined) {
		/* Named by its id, never its tag, which is a word of the Project's (layer 7's small
		 * edit, kept for the rebase). */
		throw new Error(
			`The Project's lookup table ${table.id} was read without its rows revision.`,
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
					repeatedFields: new Set(
						Object.entries(lookupSourceFieldDetails(read.table, read.rows))
							.filter(([, detail]) => detail.repeated)
							.map(([name]) => name),
					),
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
	/** When the read of CommCare HQ's lookup tables began. */
	readonly tablesReadAt: Date;
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
	const tables = input.tables.map((observed): ReadingLookupTable => {
		const tag = observed.table.tag;
		const measured = input.measured.get(tag) ?? null;
		const inline =
			observed.kind === "read" &&
			!lookupCapExcess(
				managedLookupContentOf(observed.table, observed.rows),
				measured ?? { dataBytes: 0, largestRowBytes: 0 },
			).length;
		// Retain the granted definition independently when the whole source
		// cannot be established within one interactive inventory observation.
		const read: Extract<HqLookupTableRead, { kind: "read" }> = inline
			? observed
			: {
					kind: "read",
					table: observed.table,
					rows: [],
					canonical: canonicalLookupTable(observed.table, null),
				};
		const existing = byTag.get(tag) ?? null;
		const projectTable = existing === null ? null : metProjectTable(existing);
		const findings = lookupTableFindings(read, measured);
		if (findings.length > 0) {
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
			recordFromEntries([[tag, standing]]),
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
			tablesReadAt: input.tablesReadAt,
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
			...(places?.inconsistent ? { inconsistent: true } : {}),
		},
	};
}

/** The kept columns of a Project table, none where the read named none. */
export function keptColumnsOf(
	keptColumns: Readonly<Record<string, readonly string[]>>,
	table: LookupTableDefinition,
): readonly string[] {
	return ownRecordValue(keptColumns, table.id) ?? [];
}

function rowsOf(
	rowsByTable: Readonly<Record<string, readonly LookupFixtureRow[]>>,
	table: LookupTableDefinition,
): readonly LookupFixtureRow[] | undefined {
	if (needsWorkerRows(table)) return undefined;
	if (!Object.hasOwn(rowsByTable, table.id)) {
		throw new Error(
			`The Project's lookup table ${table.id} was read without its rows.`,
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
	const unasked = Object.keys(choices).filter((tag) => !asks.has(tag));
	if (unasked.length > 0) {
		/* A count, never a tag (layer 7's small edit, kept for the rebase). */
		throw new Error(
			`Answers were given for ${unasked.length} lookup table(s) that ask no choice.`,
		);
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
			recordFromEntries([[tag, table.standing]]),
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
	/** Tags a form declares that the catalog does not hold and nothing reads
	 *  (`UnreadTable.declaredOnly`): no table comes in for one, and Core still
	 *  loads it when the form opens. */
	readonly declaredTables: readonly string[];
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
			lookupFields: NO_ENTRIES,
			...tablesOf(outcome.unreadTables),
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
	const idsByTable = new Map<LookupTableId, Set<string>>();
	for (const target of [
		...targets.columnTargets,
		...(targets.memberTargets ?? []),
	]) {
		const ids = idsByTable.get(target.tableId) ?? new Set<string>();
		ids.add("memberId" in target ? target.memberId : target.columnId);
		idsByTable.set(target.tableId, ids);
	}
	for (const [tableId, ids] of idsByTable) {
		const binding = bindingOf(tableId);
		const set = fields.get(binding.tag) ?? new Set<string>();
		for (const [name, id] of lookupBindingNames(binding))
			if (ids.delete(id)) set.add(name);
		if (ids.size)
			throw new Error(
				"The app reads a data table member that its source binding does not name.",
			);
		fields.set(binding.tag, set);
	}

	return {
		lookupFields: recordFromEntries(
			[...fields.entries()]
				.sort(([left], [right]) => compareCodeUnits(left, right))
				.map(([tag, read]) => [tag, [...read].sort(compareCodeUnits)]),
		),
		...tablesOf(facts.unreadTables),
		readsPlaces: documentReadsPlaces(doc),
	};
}

/**
 * The failed read of the levels and places a reading ends with, or null.
 * `placesUnread` ends it where the app reads places: where the reader's
 * document reads them, or, for an account, where some expression of the
 * source reads them, refused or not (`readsLocations`). The reader ran
 * without CommCare HQ's levels, so a read of a place at a level names a
 * level it does not hold and is refused as an expression no runtime can
 * evaluate as its author meant; that account would name a permission as a
 * broken app, and asking for the permission first leaves only refusals that
 * are the app's own. Where nothing in the app reads a place, the failure is
 * dropped, an account's refusals standing alone. Pure.
 */
export function unreadPlacesFailure(
	data: ReadingProjectData,
	outcome: ReadOutcome,
): HqFailure | null {
	if (data.placesUnread === null) return null;
	if (outcome.kind === "account")
		return outcome.readsLocations ? data.placesUnread : null;
	return documentReadsPlaces(outcome.draft.doc) ? data.placesUnread : null;
}

/** The tags read, and the tags only declared: a tag something reads is read
 *  wherever else a form only declares it. */
function tablesOf(unread: readonly UnreadTable[]): {
	readonly unreadTables: readonly string[];
	readonly declaredTables: readonly string[];
} {
	const read = new Set(
		unread
			.filter((table) => table.declaredOnly !== true)
			.map((table) => table.tag),
	);
	const declared = new Set(
		unread.map((table) => table.tag).filter((tag) => !read.has(tag)),
	);
	return {
		unreadTables: [...read].sort(compareCodeUnits),
		declaredTables: [...declared].sort(compareCodeUnits),
	};
}

// ---------------------------------------------------------------------------
// The findings
// ---------------------------------------------------------------------------

/** A read of a table the project space's list does not hold: an expression no runtime can evaluate as its author meant. */
const MISSING_TABLE_ENTRY =
	"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant";

/** A table a form declares and nothing reads that the project space's list does not hold: Core
 *  loads every declared instance when the form opens, and this one fails, so the form cannot open. */
const UNSERVED_DECLARATION_ENTRY =
	"expressions-and-data/declared-unreferenced-fixture-instance-the-project-space-does";

/**
 * Every finding of project data for this read. `doc` is null where the reader
 * gave an account.
 *
 * For each tag the reader read, bound or not: the table's own findings, or,
 * where CommCare HQ's list lacks the tag, a read of a table that is not
 * there. For each tag a form only declares that the list lacks: a form that
 * cannot open; one the list holds raises nothing. Then, over the tables the document reads as the birth will hold
 * them (`readingLookupSnapshot`): a cell XML cannot carry, the tables
 * together over what one `.ccz` carries, and, with a document, one
 * `table-choices-unusable` a table whose rows cannot be the choices of a
 * question or search field that reads them. Where the app reads places:
 * `places-over-nova-limit` alone where the list stopped past Nova's limit;
 * otherwise the levels Nova cannot hold, the places it cannot, and, with a
 * document, an owner rule the copy would refuse. A value of a place is judged
 * only with a document, once the rest of the app can come in.
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
	for (const tag of reads.declaredTables)
		if (!listed.has(tag))
			findings.push(
				manifestFinding(
					UNSERVED_DECLARATION_ENTRY,
					{ kind: "lookup-table", tag },
					tag,
				),
			);

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
		if (data.gathered.inconsistent) {
			findings.push(
				circumstanceFinding(
					"place-hierarchy-inconsistent",
					{ kind: "organization" },
					{},
				),
			);
		} else {
			const levels = levelsFromHq(
				data.gathered.hqLevels,
				claimsUnder(resolver),
			);
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
		const column =
			table &&
			[...lookupLexicalSlots(table)].find(
				(slot) =>
					slot.target.columnId === error.details?.columnId &&
					slot.target.memberId === error.details?.memberId,
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
		const reported = [...lookupLexicalSlots(table)].find(
			(slot) =>
				slot.target.columnId === error.details?.columnId &&
				slot.target.memberId === error.details?.memberId,
		);
		const read = carriers.find((carrier) => carrier.source.tableId === tableId)
			?.source.valueColumnId;
		const selected = read && resolveLookupRead(table, read);
		const wireName =
			reported?.wireName ??
			selected?.member?.wireName ??
			selected?.column?.wireName;
		if (!wireName)
			throw new Error(
				"The selected data detail is unavailable in the read snapshot.",
			);
		findings.push(
			circumstanceFinding(
				"table-choices-unusable",
				{ kind: "lookup-table", tag: table.tag },
				{ name: fieldName(table.tag, wireName) },
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
	/** When the read of CommCare HQ's lookup tables began (`gathered.tablesReadAt`). */
	readonly tablesReadAt: Date;
	readonly tables: readonly BroughtInTableWrite[];
	readonly places: ManagedPlacePlan | null;
}

/**
 * What the birth writes of project data, from the data under the person's
 * answers: one table write per table the document reads, and, where it reads
 * places, the plan of Nova's copy of them over CommCare HQ's levels and the
 * document's location properties. Called on a read with no finding, so a
 * table it cannot bind, a `choice` with no answer, or places that cannot come
 * in is a caller's mistake and throws. Pure.
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
	const tags = Object.keys(reads.lookupFields).sort(compareCodeUnits);
	const tables = tags.map((tag, index): BroughtInTableWrite => {
		/* A table is named by its place among the tags the document reads, never by its
		 * tag: this message reaches the route's failed line and Sentry, which hold no
		 * word of an app (layer 7's small edit, kept for the rebase). */
		const which = `${index + 1} of the ${tags.length} the document reads`;
		const table = byTag.get(tag);
		if (
			table === undefined ||
			table.read.kind !== "read" ||
			table.standing === null ||
			table.binding === null
		) {
			throw new Error(
				`The document reads a lookup table that cannot come in (table ${which}, in code-unit order of their tags).`,
			);
		}
		if (table.standing.kind === "choice" && table.choice === null) {
			throw new Error(
				`A lookup table reached the write with no answer to its choice (table ${which}, in code-unit order of their tags).`,
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
		tablesReadAt: data.gathered.tablesReadAt,
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
	if (data.gathered.inconsistent) {
		throw new Error(
			"The app reads places, and the source did not return a consistent organization.",
		);
	}
	const plan = planManagedPlaces({
		hqPlaces: data.gathered.hqPlaces,
		levels: levelsFromHq(data.gathered.hqLevels, claimsUnder(resolver)).levels,
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
