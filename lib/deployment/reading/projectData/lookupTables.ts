/**
 * The lookup tables an app brought in from CommCare HQ reads: which of the
 * project space's tables may be read, what Nova cannot hold of one, where a
 * tag that meets a Project table stands, and what each tag is bound to.
 *
 * Pure: this file reads CommCare HQ's answers and the Project's tables as it
 * is handed them and reaches neither. `lookupTableStore.ts` beside it reads
 * CommCare HQ and writes Postgres.
 */

import type {
	HqFixtureRow,
	HqLookupTable,
} from "@/lib/commcare/hq/lookupTables";
import { lookupFixtureCellText } from "@/lib/commcare/lookup/cellText";
import {
	buildLookupFixtures,
	lookupFixtureBudgetExcess,
} from "@/lib/commcare/lookup/fixtures";
import { lookupHqCellTextFindings } from "@/lib/commcare/lookup/hqCellText";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	MAX_HQ_FIXTURE_WORKBOOK_ROWS,
	TYPES_SHEET,
} from "@/lib/commcare/lookup/workbook";
import { lookupXmlTextFindings } from "@/lib/commcare/lookup/xmlText";
import type {
	ReaderLookupCatalog,
	ReadOutcome,
} from "@/lib/commcare/reader/types";
import { xmlTextIssue } from "@/lib/commcare/xmlText";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { ownRecordValue, recordFromEntries } from "@/lib/domain/records";
import {
	isReservedInstanceTag,
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TAG_LENGTH,
	LOOKUP_MAX_WIRE_NAME_LENGTH,
	LOOKUP_WIRE_IDENTIFIER_PATTERN,
	LOOKUP_XML_PREFIX_PATTERN,
} from "@/lib/lookup/constants";
import { formatLookupBytes } from "@/lib/lookup/format";
import {
	columnLabelFor,
	type LookupRowsMeasure,
	lookupCapExcess,
	type ManagedLookupContent,
} from "@/lib/lookup/managedRules";
import { lookupTagSchema, lookupWireNameSchema } from "@/lib/lookup/schema";
import type {
	LookupColumn,
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
	LookupReferencingAppSummary,
	LookupRevision,
	LookupRowId,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import {
	circumstanceFinding,
	type Finding,
	type HqPlace,
} from "@/lib/publish/hqFindings";
import { unsupportedLookupContent } from "../../lookupResourcePlan";
import type { SiblingLookupMapping } from "../../store";
import type { CanonicalLookupTable } from "../../types";
import { manifestFinding } from "./findings";
import type { ReaderProjectDataReads, ReadingProjectData } from "./index";
import { broughtInLookupColumnId, broughtInLookupTableId } from "./lookupIds";
import {
	LOOKUP_TABLE_CHOICES,
	type LookupChoiceOffer,
	type LookupTableChoice,
	type ReviewTable,
} from "./reviewTypes";

// ---------------------------------------------------------------------------
// Which tables the app reads
// ---------------------------------------------------------------------------

/**
 * The tags of `tables`, in its order, for which `sourceText` (the raw body and
 * every form's attachment) holds the string `item-list:<tag>`. A form declares
 * a table's instance `jr://fixture/item-list:<tag>` whatever id it gave the
 * instance, and a suite expression names `instance('item-list:<tag>')`. A test
 * of names CommCare HQ gave, which reads no expression: it can only name too
 * many (a tag that begins another tag is named with it).
 */
export function candidateLookupTags(
	sourceText: string,
	tables: readonly HqLookupTable[],
): readonly string[] {
	const tags: string[] = [];
	const seen = new Set<string>();
	for (const table of tables) {
		if (seen.has(table.tag)) continue;
		if (!sourceText.includes(`item-list:${table.tag}`)) continue;
		seen.add(table.tag);
		tags.push(table.tag);
	}
	return tags;
}

/**
 * The tags the reader read: those of the tables the document references
 * through `catalog`, and each tag of `ReadFacts.unreadTables` an expression or
 * an itemset reads, each once, in code-unit order. A table a form only
 * declares (`declaredOnly`) is read by nothing and comes in with nothing.
 */
export function lookupTagsRead(
	read: Extract<ReadOutcome, { kind: "read" }>,
	catalog: ReaderLookupCatalog,
): readonly string[] {
	const tags = new Set<string>();
	for (const tableId of extractLookupReferenceTargets(read.draft.doc)
		.tableIds) {
		const definition = catalog.definitions.get(tableId);
		if (definition === undefined) {
			throw new Error(
				`A reading's document references the lookup table ${tableId}, which its catalog does not hold.`,
			);
		}
		tags.add(definition.tag);
	}
	for (const unread of read.draft.facts.unreadTables)
		if (unread.declaredOnly !== true) tags.add(unread.tag);
	return [...tags].sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** One candidate table as the read gave it. */
export type HqLookupTableRead =
	| {
			readonly kind: "read";
			readonly table: HqLookupTable;
			readonly rows: readonly HqFixtureRow[];
			readonly canonical: CanonicalLookupTable;
	  }
	/** CommCare HQ's first page named more rows than `LOOKUP_MAX_ROWS`: no further page was read. */
	| {
			readonly kind: "over-row-limit";
			readonly table: HqLookupTable;
			readonly totalCount: number;
	  }
	/**
	 * The table's rows passed `bounds.ts::HQ_LOOKUP_TABLE_ROWS_MAX_BYTES` on
	 * CommCare HQ's wire, which no table within Nova's caps does: the read
	 * stopped there and kept nothing.
	 */
	| { readonly kind: "over-byte-limit"; readonly table: HqLookupTable }
	| { readonly kind: "rows-unreadable"; readonly table: HqLookupTable };

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** A field's one value in a row: its string, the one value of a one-item list,
 *  `""` where the row lacks the field, and null where it holds several values. */
function hqCell(row: HqFixtureRow, field: string): string | null {
	if (!Object.hasOwn(row.fields, field)) return "";
	const value = row.fields[field];
	if (typeof value === "string") return value;
	const [only] = value;
	return value.length === 1 && only !== undefined ? only.value : null;
}

/** Whether some row holds a field with other than one value, which Nova's
 *  table model cannot hold. */
function holdsOtherThanOneValue(rows: readonly HqFixtureRow[]): boolean {
	return rows.some((row) =>
		Object.values(row.fields).some(
			(value) => typeof value !== "string" && value.length !== 1,
		),
	);
}

/**
 * CommCare HQ's columns and rows as a copy takes them: the definition's fields
 * in its order, and each row's one value of each field it holds. A cell of a
 * field the definition does not name is not read, since no device receives
 * it; a field holding several values is left out of its row (a table holding
 * one is a finding and is never written).
 */
export function managedLookupContentOf(
	table: HqLookupTable,
	rows: readonly HqFixtureRow[],
): ManagedLookupContent {
	return {
		fields: table.fields,
		rows: rows.map((row) =>
			recordFromEntries(
				table.fields.flatMap((field) => {
					if (!Object.hasOwn(row.fields, field)) return [];
					const value = hqCell(row, field);
					return value === null ? [] : [[field, value]];
				}),
			),
		),
	};
}

// ---------------------------------------------------------------------------
// What Nova cannot hold
// ---------------------------------------------------------------------------

const CAPS_ENTRY =
	"expressions-and-data/table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64";
const FIELD_PROPERTIES_ENTRY =
	"expressions-and-data/fields-properties-and-multi-valued-cells-name-lang-en-name-name";
const ROW_ATTRIBUTES_ENTRY =
	"expressions-and-data/item-attributes-and-per-row-attribute-values";
const NOT_GLOBAL_ENTRY =
	"expressions-and-data/is-global-false-row-owners-user-group-location";
const TAG_TYPES_ENTRY = "expressions-and-data/tag-types";
const RESERVED_WORD_ENTRY =
	"expressions-and-data/tag-containing-casedb-or-ledgerdb";
const NON_ASCII_NAME_ENTRY =
	"expressions-and-data/tag-or-field-name-with-non-ascii-letters";
const PERIOD_NAME_ENTRY =
	"expressions-and-data/tag-or-field-name-holding-a-period";
const NON_ASCII_LETTER = /\p{L}/gu;

/** Whether `name` is in Nova's name grammar, reserved instance names aside. */
function inNameGrammar(name: string, maxLength: number): boolean {
	return (
		name.length > 0 &&
		name.length <= maxLength &&
		LOOKUP_WIRE_IDENTIFIER_PATTERN.test(name) &&
		!LOOKUP_XML_PREFIX_PATTERN.test(name)
	);
}

/**
 * The finding for a tag or a field name Nova's grammar refuses, or null where
 * it takes it (or where the refusal is the `casedb` row's, raised beside it).
 * A name that is in the grammar once its non-ASCII letters are read as
 * letters is the HELD-NEW non-ASCII entry; one that is in it once each period
 * is read as an underscore is the period entry; anything else is `unrecognized`.
 */
function nameFinding(
	kind: "tag" | "field",
	name: string,
	place: HqPlace,
): Finding | null {
	const schema = kind === "tag" ? lookupTagSchema : lookupWireNameSchema;
	if (schema.safeParse(name).success) return null;
	const maxLength =
		kind === "tag" ? LOOKUP_MAX_TAG_LENGTH : LOOKUP_MAX_WIRE_NAME_LENGTH;
	if (
		kind === "tag" &&
		inNameGrammar(name, maxLength) &&
		isReservedInstanceTag(name)
	)
		return null;
	const hasNonAscii = [...name.matchAll(NON_ASCII_LETTER)].some(
		([letter]) => (letter.codePointAt(0) ?? 0) > 0x7f,
	);
	const hasPeriod = name.includes(".");
	const asAscii = name
		.replace(NON_ASCII_LETTER, (letter) =>
			(letter.codePointAt(0) ?? 0) > 0x7f ? "a" : letter,
		)
		.replaceAll(".", "_");
	if ((hasNonAscii || hasPeriod) && inNameGrammar(asAscii, maxLength)) {
		return manifestFinding(
			hasNonAscii ? NON_ASCII_NAME_ENTRY : PERIOD_NAME_ENTRY,
			place,
			name,
		);
	}
	return circumstanceFinding("unrecognized", place, { name });
}

function count(value: number): string {
	return value.toLocaleString("en-US");
}

/**
 * What Nova cannot hold of one candidate table, every finding at
 * `{ kind: "lookup-table", tag }`. `measured` is Postgres's measure of the
 * table's rows, null for a read with no rows Nova can store (rows that could
 * not be read, a table over the row cap, a field holding several values, a
 * cell XML cannot carry), when the two byte caps are not judged. A field name
 * is judged whether or not the app reads it. Pure.
 */
export function lookupTableFindings(
	read: HqLookupTableRead,
	measured: LookupRowsMeasure | null,
): readonly Finding[] {
	const { table } = read;
	const tag = table.tag;
	const place: HqPlace = { kind: "lookup-table", tag };
	const findings: Finding[] = [];

	const holds = unsupportedLookupContent(table);
	if (holds.includes("field-properties")) {
		findings.push(
			manifestFinding(
				FIELD_PROPERTIES_ENTRY,
				place,
				`${tag}: field properties`,
			),
		);
	}
	if (read.kind === "read" && holdsOtherThanOneValue(read.rows)) {
		findings.push(
			manifestFinding(
				FIELD_PROPERTIES_ENTRY,
				place,
				`${tag}: a field with more than one value`,
			),
		);
	}
	if (holds.includes("row-attributes")) {
		findings.push(
			manifestFinding(ROW_ATTRIBUTES_ENTRY, place, `${tag}: row attributes`),
		);
	}
	if (holds.includes("not-global")) {
		findings.push(
			manifestFinding(
				NOT_GLOBAL_ENTRY,
				place,
				`${tag}: rows limited to certain users`,
			),
		);
	}

	if (read.kind === "over-row-limit") {
		findings.push(
			manifestFinding(
				CAPS_ENTRY,
				place,
				`${tag}: ${count(read.totalCount)} rows (Nova takes ${count(LOOKUP_MAX_ROWS)})`,
			),
		);
	} else if (read.kind === "over-byte-limit") {
		findings.push(
			manifestFinding(
				CAPS_ENTRY,
				place,
				`${tag}: more data than Nova reads for one table`,
			),
		);
	} else if (read.kind === "read") {
		const phrases = lookupCapExcess(
			managedLookupContentOf(table, read.rows),
			measured ?? { dataBytes: 0, largestRowBytes: 0 },
		);
		for (const phrase of phrases) {
			findings.push(manifestFinding(CAPS_ENTRY, place, `${tag}: ${phrase}`));
		}
	}

	if (tag.toLowerCase() === TYPES_SHEET) {
		findings.push(manifestFinding(TAG_TYPES_ENTRY, place, TYPES_SHEET));
	}
	if (isReservedInstanceTag(tag)) {
		findings.push(manifestFinding(RESERVED_WORD_ENTRY, place, tag));
	}
	const tagFinding = nameFinding("tag", tag, place);
	if (tagFinding !== null) findings.push(tagFinding);
	// CommCare HQ's Manage Tables page saves a table with no field
	// (`fixtures/views.py::update_tables` checks only the tag and the field
	// names); Nova's table holds one column at least. A field added there
	// settles it.
	if (table.fields.length === 0) {
		findings.push(
			circumstanceFinding("table-has-no-fields", place, { name: tag }),
		);
	}
	// CommCare HQ holds two fields of one name: nothing in `fixtures` checks a
	// field list for repeats. Manage Tables renames a field onto another's name
	// (`fixtures/views.py::_update_types` keeps the untouched field beside the
	// renamed one), the lookup table API saves the list it is sent
	// (`resources/v0_1.py::LookupTableResource.obj_create`, `obj_update`), and
	// a workbook upload takes its `field N` headers as they stand
	// (`upload/workbook.py::_FixtureTableDefinition.from_row`). A row holds one
	// value per name (`LookupTableRow.fields` is a dict), and Nova's table one
	// column per name, so a field renamed there settles it.
	const seenFields = new Set<string>();
	const repeated = new Set<string>();
	for (const field of table.fields) {
		if (seenFields.has(field)) {
			if (!repeated.has(field)) {
				repeated.add(field);
				findings.push(
					circumstanceFinding("table-field-repeated", place, {
						name: `${tag} (the field ${field})`,
					}),
				);
			}
			continue;
		}
		seenFields.add(field);
		const fieldFinding = nameFinding("field", field, place);
		if (fieldFinding !== null) findings.push(fieldFinding);
	}

	if (read.kind === "read") {
		for (const field of seenFields) {
			const unrepresentable = read.rows.some((row) => {
				if (!Object.hasOwn(row.fields, field)) return false;
				const value = row.fields[field];
				return typeof value === "string"
					? xmlTextIssue(value) !== undefined
					: value.some((item) => xmlTextIssue(item.value) !== undefined);
			});
			if (unrepresentable) {
				findings.push(
					circumstanceFinding("table-cell-unrepresentable", place, {
						name: `${tag} (the field ${field})`,
					}),
				);
			}
		}
	}
	if (read.kind === "rows-unreadable") {
		findings.push(
			circumstanceFinding("table-rows-unreadable", place, { name: tag }),
		);
	}
	return findings;
}

// ---------------------------------------------------------------------------
// What each tag is bound to
// ---------------------------------------------------------------------------

/** One table of the reader's definitions. */
type IndexedLookupDefinition =
	LookupDefinitionIndex extends ReadonlyMap<LookupTableId, infer Definition>
		? Definition
		: never;

/** The table and columns one tag's fields are bound to. */
export interface LookupTableBinding {
	readonly tag: string;
	readonly tableId: LookupTableId;
	/** Field name to the column that holds it. */
	readonly columns: Readonly<Record<string, LookupColumnId>>;
}

/**
 * The catalog the reader binds against: one entry per binding, and nothing
 * else. `definitions` holds, for each binding's table, a column per field in
 * CommCare HQ's order, its id from the binding, its wire name the field's
 * name, its label `columnLabelFor` of it and its type `text`; for a tag bound
 * to a Project table as it stands (`asItStands`), that table's own columns
 * with their own types, because that is the table the app will read.
 */
export function readerLookupCatalog(
	bound: readonly {
		readonly binding: LookupTableBinding;
		readonly name: string;
		/** CommCare HQ's field names in its order. */
		readonly fields: readonly string[];
		/** The Project table the tag is bound to as it stands (`same-equal`, or the answer
		 *  `use-project`); absent for any other binding. */
		readonly asItStands?: LookupTableDefinition;
	}[],
): ReaderLookupCatalog {
	const byTag = new Map<string, LookupTableBinding>();
	const definitions = new Map<LookupTableId, IndexedLookupDefinition>();
	for (const { binding, name, fields, asItStands } of bound) {
		if (byTag.has(binding.tag)) {
			/* These name a table by its id, never its tag or a field's name: the message
			 * reaches the route's failed line and Sentry (layer 7's small
			 * edits, kept for the rebase). */
			throw new Error(
				`The lookup catalog was handed two bindings of one tag, the second bound to ${binding.tableId}.`,
			);
		}
		byTag.set(binding.tag, binding);
		if (asItStands !== undefined) {
			if (asItStands.id !== binding.tableId) {
				throw new Error(
					`A lookup table is bound to ${binding.tableId}, not to the Project table it stands as, ${asItStands.id}.`,
				);
			}
			definitions.set(binding.tableId, {
				id: binding.tableId,
				name: asItStands.name,
				tag: asItStands.tag,
				columns: asItStands.columns.map((column) => ({
					id: column.id,
					wireName: column.wireName,
					label: column.label,
					dataType: column.dataType,
				})),
			});
			continue;
		}
		definitions.set(binding.tableId, {
			id: binding.tableId,
			name,
			tag: binding.tag,
			columns: fields.map((field, index) => {
				if (!Object.hasOwn(binding.columns, field)) {
					throw new Error(
						`The lookup table bound to ${binding.tableId} has no column for its field ${index + 1}.`,
					);
				}
				return {
					id: binding.columns[field],
					wireName: field,
					label: columnLabelFor(field),
					dataType: "text" as const,
				};
			}),
		});
	}
	return {
		table(tag) {
			const binding = byTag.get(tag);
			if (binding === undefined) return undefined;
			return {
				tableId: binding.tableId,
				column(fieldName) {
					return Object.hasOwn(binding.columns, fieldName)
						? binding.columns[fieldName]
						: undefined;
				},
			};
		},
		definitions,
	};
}

// ---------------------------------------------------------------------------
// A tag that meets a Project table
// ---------------------------------------------------------------------------

/** Where a candidate tag stands against the Project's tables. */
export type LookupTableStanding =
	/** No Project table has the tag: a new table, managed in CommCare HQ. */
	| { readonly kind: "new" }
	/** The Project's table is already managed from this project space: the same table. */
	| { readonly kind: "same-managed"; readonly table: LookupTableDefinition }
	/** The Project's table has equal columns and rows, Nova manages it, and one of the Project's
	 *  apps already publishes it as this very table of this project space: the same table. */
	| { readonly kind: "same-equal"; readonly table: LookupTableDefinition }
	/** A table the person chooses about: a different one, or an equal one nothing accounts for. */
	| {
			readonly kind: "choice";
			readonly table: LookupTableDefinition;
			/** Empty exactly when the two are equal. */
			readonly differs: readonly ("columns" | "rows")[];
			/** Who manages the Project's table today. */
			readonly managed:
				| { readonly by: "nova" }
				| { readonly by: "commcare-hq"; readonly domain: string };
			readonly apps: readonly LookupReferencingAppSummary[];
			readonly options: Readonly<Record<LookupTableChoice, LookupChoiceOffer>>;
	  };

/** What a fixture writes for a Project row's column: a missing cell is `""`. */
function projectCellText(column: LookupColumn, row: LookupFixtureRow): string {
	return lookupFixtureCellText(column.dataType, row.values[column.id]);
}

/** The same field names in the same order as the columns' wire names, every column text. */
function columnsEqual(
	read: Extract<HqLookupTableRead, { kind: "read" }>,
	table: LookupTableDefinition,
): boolean {
	return (
		table.columns.length === read.table.fields.length &&
		table.columns.every(
			(column, index) =>
				column.wireName === read.table.fields[index] &&
				column.dataType === "text",
		)
	);
}

/**
 * The same rows in the same order, cell for cell, a missing cell equal to an
 * empty one: each field's cell against the column of its wire name (a field
 * with no column against `""`), and every column with no field empty.
 */
function rowsEqual(
	read: Extract<HqLookupTableRead, { kind: "read" }>,
	table: LookupTableDefinition,
	rows: readonly LookupFixtureRow[],
): boolean {
	if (rows.length !== read.rows.length) return false;
	const byWireName = new Map(
		table.columns.map((column) => [column.wireName, column]),
	);
	const fields = new Set(read.table.fields);
	const unnamed = table.columns.filter(
		(column) => !fields.has(column.wireName),
	);
	return read.rows.every((hqRow, index) => {
		const projectRow = rows[index];
		if (projectRow === undefined) return false;
		for (const field of fields) {
			const cell = hqCell(hqRow, field);
			if (cell === null) return false;
			const column = byWireName.get(field);
			const projectCell =
				column === undefined ? "" : projectCellText(column, projectRow);
			if (cell !== projectCell) return false;
		}
		return unnamed.every(
			(column) => projectCellText(column, projectRow) === "",
		);
	});
}

/**
 * A snapshot of one Project table, for the export rules that judge one. The
 * rules read its definitions and rows alone, never its Project or revision.
 */
function oneTableSnapshot(
	table: LookupTableDefinition,
	rows: readonly LookupFixtureRow[],
): LookupFixtureDataSnapshot {
	return {
		projectId: "",
		projectRevision: "0" as LookupRevision,
		definitions: [table],
		rowsByTable: new Map([[table.id, rows]]),
	};
}

/**
 * The rows a workbook of this one table holds, counted as
 * `lib/commcare/lookup/workbook.ts::buildLookupWorkbook` counts
 * `totalWorkbookRows`: the types sheet's header and one row for the table,
 * then the table's sheet with its header.
 */
function oneTableWorkbookRows(rows: readonly LookupFixtureRow[]): number {
	return 2 + 1 + rows.length;
}

/**
 * Whether a workbook to the reading's project space would take the Project's
 * table as it stands, by the three rules the export boundary holds one to: a
 * tag other than `types` in any case, no cell CommCare HQ's upload would trim,
 * and a workbook within CommCare HQ's row ceiling.
 */
function passesProjectSpaceRules(
	table: LookupTableDefinition,
	rows: readonly LookupFixtureRow[],
): boolean {
	return (
		table.tag.toLowerCase() !== TYPES_SHEET &&
		lookupHqCellTextFindings(oneTableSnapshot(table, rows)).length === 0 &&
		oneTableWorkbookRows(rows) <= MAX_HQ_FIXTURE_WORKBOOK_ROWS
	);
}

/** Whether a cell of the table holds a character XML 1.0 cannot carry, which every export
 *  of an app reading it refuses (`LOOKUP_CELL_TEXT_UNREPRESENTABLE`). */
function holdsUnrepresentableCell(
	table: LookupTableDefinition,
	rows: readonly LookupFixtureRow[],
): boolean {
	return lookupXmlTextFindings(oneTableSnapshot(table, rows)).length > 0;
}

/**
 * The columns the Project's table holds once CommCare HQ's content fills it,
 * as `lib/lookup/managed.ts::refreshManagedLookupTableInTransaction` counts
 * them in both its modes: CommCare HQ's fields, and each column no field names
 * that an app's reference edge names or an accepted design protects.
 */
export function columnsAfterHqFills(
	read: Extract<HqLookupTableRead, { kind: "read" }>,
	table: LookupTableDefinition,
	keptColumnIds: readonly string[],
): number {
	const fields = new Set(read.table.fields);
	const kept = new Set(keptColumnIds);
	return (
		read.table.fields.length +
		table.columns.filter(
			(column) => !fields.has(column.wireName) && kept.has(column.id),
		).length
	);
}

/** The cap's phrase for a table CommCare HQ's content would fill past `LOOKUP_MAX_COLUMNS`. */
function keptColumnsPhrase(columnCount: number): string {
	return `${count(columnCount)} columns with the ones apps still read (Nova takes ${count(LOOKUP_MAX_COLUMNS)})`;
}

/**
 * The caps finding of a `same-managed` tag whose refresh would hold more than
 * `LOOKUP_MAX_COLUMNS` columns once the columns apps still read are kept; null
 * for any other standing, or within the cap. Pure.
 */
export function sameManagedColumnCapFinding(
	read: Extract<HqLookupTableRead, { kind: "read" }>,
	standing: LookupTableStanding,
	keptColumnIds: readonly string[],
): Finding | null {
	if (standing.kind !== "same-managed") return null;
	const columns = columnsAfterHqFills(read, standing.table, keptColumnIds);
	if (columns <= LOOKUP_MAX_COLUMNS) return null;
	const tag = read.table.tag;
	return manifestFinding(
		CAPS_ENTRY,
		{ kind: "lookup-table", tag },
		`${tag}: ${keptColumnsPhrase(columns)}`,
	);
}

/**
 * Where a candidate tag stands against the Project's table of that tag. A
 * standing's kind does not depend on which fields the app reads; the
 * `use-project` offer does (`appReads`).
 */
export function lookupTableStanding(input: {
	readonly read: Extract<HqLookupTableRead, { kind: "read" }>;
	readonly origin: { readonly server: string; readonly domain: string };
	/** The Project's table of that tag with its rows, or null. One snapshot read. */
	readonly existing: {
		readonly table: LookupTableDefinition;
		readonly rows: readonly LookupFixtureRow[];
	} | null;
	readonly apps: readonly LookupReferencingAppSummary[];
	/**
	 * Live mappings of the Project's apps for the Project's table on this project space:
	 * `readSiblingLookupMappings` with the app's derived id as the app, which names no
	 * deployment yet, so every app of the Project is a sibling. Empty where there is no table.
	 */
	readonly siblings: readonly SiblingLookupMapping[];
	/** The field names the reader bound for this tag. */
	readonly appReads: readonly string[];
	/** The Project's `delete` capability. */
	readonly mayAdminister: boolean;
	/** The ids of the Project table's columns an app's reference edge names or an accepted
	 *  design protects (`readKeptLookupColumnIds`), which CommCare HQ's content keeps. */
	readonly keptColumnIds: readonly string[];
}): LookupTableStanding {
	const { read, origin, existing } = input;
	if (existing === null) return { kind: "new" };
	const { table, rows } = existing;
	const hq = table.hq;
	if (
		hq !== undefined &&
		hq.managedBy === "commcare-hq" &&
		hq.server === origin.server &&
		hq.domain === origin.domain
	) {
		return { kind: "same-managed", table };
	}
	const managedElsewhere =
		hq !== undefined && hq.managedBy === "commcare-hq" ? hq : null;
	const sameColumns = columnsEqual(read, table);
	const sameRows = rowsEqual(read, table, rows);
	const accounted = input.siblings.some(
		(sibling) =>
			sibling.tableId === table.id &&
			sibling.pushedIdentity === read.table.tag &&
			sibling.remoteId === read.table.id,
	);
	const passesRules = passesProjectSpaceRules(table, rows);
	if (
		managedElsewhere === null &&
		sameColumns &&
		sameRows &&
		accounted &&
		passesRules
	) {
		return { kind: "same-equal", table };
	}

	const fields = new Set(read.table.fields);
	const columnsHeld = columnsAfterHqFills(read, table, input.keptColumnIds);
	const useCommCareHq: LookupChoiceOffer =
		managedElsewhere !== null
			? {
					offered: false,
					why: "managed-elsewhere",
					name: managedElsewhere.domain,
				}
			: !input.mayAdminister
				? { offered: false, why: "needs-admin", name: null }
				: columnsHeld > LOOKUP_MAX_COLUMNS
					? {
							offered: false,
							why: "too-many-columns",
							name: count(columnsHeld),
						}
					: {
							offered: true,
							goneColumns:
								input.apps.length === 0
									? []
									: table.columns
											.filter((column) => !fields.has(column.wireName))
											.map((column) => column.label),
							retypedColumns: table.columns
								.filter((column) => column.dataType !== "text")
								.map((column) => column.label),
						};

	const wireNames = new Set(table.columns.map((column) => column.wireName));
	const reads = new Set(input.appReads);
	const missing = [
		...read.table.fields.filter((field) => reads.has(field)),
		...input.appReads.filter((field) => !fields.has(field)),
	].find((field) => !wireNames.has(field));
	const useProject: LookupChoiceOffer =
		missing !== undefined
			? { offered: false, why: "app-reads-a-missing-column", name: missing }
			: !passesRules || holdsUnrepresentableCell(table, rows)
				? { offered: false, why: "fails-a-project-space-rule", name: null }
				: { offered: true, goneColumns: [], retypedColumns: [] };

	return {
		kind: "choice",
		table,
		differs: [
			...(sameColumns ? [] : (["columns"] as const)),
			...(sameRows ? [] : (["rows"] as const)),
		],
		managed:
			managedElsewhere !== null
				? { by: "commcare-hq", domain: managedElsewhere.domain }
				: { by: "nova" },
		apps: input.apps,
		options: { "use-commcare-hq": useCommCareHq, "use-project": useProject },
	};
}

/** The Project table's columns by wire name, with derived ids for the fields it lacks. */
function projectTableBinding(
	read: Extract<HqLookupTableRead, { kind: "read" }>,
	table: LookupTableDefinition,
	ids: { readonly appId: string; readonly readingId: string },
): LookupTableBinding {
	const byWireName = new Map(
		table.columns.map((column) => [column.wireName, column.id]),
	);
	return {
		tag: read.table.tag,
		tableId: table.id,
		columns: recordFromEntries(
			read.table.fields.map((field) => [
				field,
				byWireName.get(field) ??
					broughtInLookupColumnId(
						ids.appId,
						ids.readingId,
						read.table.tag,
						field,
					),
			]),
		),
	};
}

/** The Project table as it is: every column, by its wire name. */
function asItStandsBinding(
	tag: string,
	table: LookupTableDefinition,
): LookupTableBinding {
	return {
		tag,
		tableId: table.id,
		columns: recordFromEntries(
			table.columns.map((column) => [column.wireName, column.id]),
		),
	};
}

/**
 * One binding per read, in the reads' order. `standings` is by tag. A `new`
 * tag takes the derived ids; a tag bound to a table CommCare HQ's content will
 * fill (`same-managed`, a `choice` answered `use-commcare-hq` or not yet
 * answered) takes the Project table's id, its columns by wire name and derived
 * ids for the fields it lacks; a tag bound as it stands (`same-equal`, a
 * `choice` answered `use-project`) takes the Project table as it is. No answer
 * moves a binding the reader read: `use-project` is offered only where every
 * field the app reads has a column. Pure.
 */
export function resolveLookupBindings(
	reads: readonly Extract<HqLookupTableRead, { kind: "read" }>[],
	standings: Readonly<Record<string, LookupTableStanding>>,
	choices: Readonly<Record<string, LookupTableChoice>> | null,
	/** The two ids every lookup id of the reading derives from. */
	ids: { readonly appId: string; readonly readingId: string },
): readonly LookupTableBinding[] {
	return reads.map((read, index) => {
		const tag = read.table.tag;
		const standing = ownRecordValue(standings, tag);
		if (standing === undefined) {
			/* Named by its place among the reads, never its tag: this reaches the route's
			 * failed line and Sentry (layer 7's small edit, kept for the rebase). */
			throw new Error(
				`A lookup table was bound with no standing (read ${index + 1} of ${reads.length}).`,
			);
		}
		if (standing.kind === "new") {
			return {
				tag,
				tableId: broughtInLookupTableId(ids.appId, ids.readingId, tag),
				columns: recordFromEntries(
					read.table.fields.map((field) => [
						field,
						broughtInLookupColumnId(ids.appId, ids.readingId, tag, field),
					]),
				),
			};
		}
		if (standing.kind === "same-equal") {
			return asItStandsBinding(tag, standing.table);
		}
		const choice =
			standing.kind === "choice"
				? (ownRecordValue(choices ?? undefined, tag) ?? null)
				: null;
		return choice === "use-project"
			? asItStandsBinding(tag, standing.table)
			: projectTableBinding(read, standing.table, ids);
	});
}

/** Which review tables need an answer, and whether the answers given can be taken. */
export function resolveTableChoices(
	tables: readonly ReviewTable[],
	answers: Readonly<Record<string, string>>,
):
	| {
			readonly ok: true;
			readonly choices: Readonly<Record<string, LookupTableChoice>>;
	  }
	| {
			readonly ok: false;
			readonly missing: readonly string[];
			readonly notOffered: readonly string[];
			readonly unknown: readonly string[];
	  } {
	const byTag = new Map(tables.map((table) => [table.tag, table]));
	const missing: string[] = [];
	const notOffered: string[] = [];
	const unknown: string[] = [];
	const choices: [string, LookupTableChoice][] = [];
	for (const table of tables) {
		if (table.choice !== null && !Object.hasOwn(answers, table.tag)) {
			missing.push(table.tag);
		}
	}
	for (const tag of Object.keys(answers).sort(compareCodeUnits)) {
		const answer = answers[tag];
		const choice = byTag.get(tag)?.choice ?? null;
		const known = (LOOKUP_TABLE_CHOICES as readonly string[]).includes(answer);
		if (choice === null || !known) {
			unknown.push(tag);
			continue;
		}
		const value = answer as LookupTableChoice;
		if (!choice.options[value].offered) {
			notOffered.push(tag);
			continue;
		}
		choices.push([tag, value]);
	}
	if (missing.length > 0 || notOffered.length > 0 || unknown.length > 0) {
		return { ok: false, missing, notOffered, unknown };
	}
	return { ok: true, choices: recordFromEntries(choices) };
}

// ---------------------------------------------------------------------------
// The tables the document reads, as the birth will hold them
// ---------------------------------------------------------------------------

/** Whether a gathered tag is bound to its Project table as it stands. */
export function boundAsItStands(
	standing: LookupTableStanding,
	choice: LookupTableChoice | null,
): standing is Extract<
	LookupTableStanding,
	{ readonly kind: "same-equal" | "choice" }
> {
	return (
		standing.kind === "same-equal" ||
		(standing.kind === "choice" && choice === "use-project")
	);
}

/**
 * The tables the document reads (the tags of `reads.lookupFields`), as the
 * birth will hold them, in tag order. A table that comes in as CommCare HQ's
 * (`new`, `same-managed`, and a `choice` with no answer or answered
 * `use-commcare-hq`) is the definition the reader's catalog gives it, every
 * column text, with CommCare HQ's rows in its order, each cell under its
 * column's id and a missing cell missing; a row's id is CommCare HQ's, which
 * no document names. A table bound to a Project table as it stands
 * (`same-equal`, and a `choice` answered `use-project`) is that table's own
 * definition with the Project's rows. The Project and its revision are the
 * ones the read saw. Pure.
 */
export function readingLookupSnapshot(
	data: ReadingProjectData,
	reads: ReaderProjectDataReads,
): LookupFixtureDataSnapshot {
	const byTag = new Map(
		data.gathered.tables.map((table) => [table.read.table.tag, table]),
	);
	const definitions: LookupTableDefinition[] = [];
	const rowsByTable = new Map<LookupTableId, readonly LookupFixtureRow[]>();
	const tags = Object.keys(reads.lookupFields).sort(compareCodeUnits);
	for (const [index, tag] of tags.entries()) {
		const gathered = byTag.get(tag);
		if (
			gathered === undefined ||
			gathered.read.kind !== "read" ||
			gathered.standing === null ||
			gathered.binding === null
		) {
			/* By its place, never its tag (layer 7's small edit, kept for the
			 * rebase). */
			throw new Error(
				`The document reads a lookup table the reading bound to nothing (table ${index + 1} of the ${tags.length} it reads).`,
			);
		}
		const { read, standing, binding } = gathered;
		if (boundAsItStands(standing, gathered.choice)) {
			const rows = data.gathered.project.rowsByTable[standing.table.id];
			if (rows === undefined) {
				throw new Error(
					`The reading holds no rows of the Project's lookup table ${standing.table.id}.`,
				);
			}
			definitions.push(standing.table);
			rowsByTable.set(standing.table.id, rows);
			continue;
		}
		const definition = data.lookups.definitions.get(binding.tableId);
		if (definition === undefined) {
			throw new Error(
				`The reader's catalog holds no definition of the lookup table ${binding.tableId}.`,
			);
		}
		definitions.push({
			id: definition.id,
			name: definition.name,
			tag: definition.tag,
			definitionRevision: (gathered.projectTable?.definitionRevision ??
				"0") as LookupRevision,
			columns: definition.columns.map((column) => ({
				id: column.id,
				wireName: column.wireName,
				label: column.label,
				dataType: "text" as const,
			})),
		});
		rowsByTable.set(
			binding.tableId,
			read.rows.map((row) => ({
				id: row.id as LookupRowId,
				values: recordFromEntries(
					read.table.fields.flatMap((field) => {
						if (!Object.hasOwn(row.fields, field)) return [];
						const cell = hqCell(row, field);
						if (cell === null || !Object.hasOwn(binding.columns, field)) {
							return [];
						}
						return [[binding.columns[field], cell]];
					}),
				),
			})),
		);
	}
	return {
		projectId: data.gathered.project.projectId,
		projectRevision: data.gathered.project.projectRevision,
		definitions,
		rowsByTable,
	};
}

/**
 * The tables of `snapshot` together over what one `.ccz` carries, as one
 * finding at the app under the caps entry, each axis named and joined with
 * " and "; null where they fit. The fixtures are built as the compiler
 * builds them (`buildLookupFixtures` over the snapshot's own naming). Pure.
 */
export function lookupFixtureBudgetFinding(
	snapshot: LookupFixtureDataSnapshot,
): Finding | null {
	const excess = lookupFixtureBudgetExcess(
		buildLookupFixtures(
			lookupWireNaming(snapshot.definitions),
			snapshot.rowsByTable,
		),
	);
	if (excess === null) return null;
	const phrases = excess.map((axis) =>
		axis.axis === "rows"
			? `${count(axis.actual)} lookup table rows (Nova takes ${count(axis.allowed)} in one app)`
			: axis.axis === "cells"
				? `${count(axis.actual)} lookup table values (Nova takes ${count(axis.allowed)} in one app)`
				: `${formatLookupBytes(axis.actual)} of lookup table data (Nova takes ${formatLookupBytes(axis.allowed)} in one app)`,
	);
	return manifestFinding(CAPS_ENTRY, { kind: "app" }, phrases.join(" and "));
}

/** What the birth writes for one tag. */
export interface BroughtInTableWrite {
	readonly read: Extract<HqLookupTableRead, { kind: "read" }>;
	readonly standing: LookupTableStanding;
	readonly choice: LookupTableChoice | null;
	readonly binding: LookupTableBinding;
	/** The Project table the tag met, at the revisions the read saw; null where none. */
	readonly projectTable: {
		readonly tableId: LookupTableId;
		readonly definitionRevision: string;
		readonly rowsRevision: string;
	} | null;
}
