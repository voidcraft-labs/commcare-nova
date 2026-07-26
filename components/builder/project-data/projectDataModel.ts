// Pure derivations for the Project data workspace.
//
// Everything here is a function of its arguments — no React, no store, no
// network — so the workspace's decisions are unit-testable without mounting
// a grid. The rule the workspace follows: a derivation that decides what an
// author sees (a size, a capacity phrase, a conflict verdict) lives here, and
// the components only render it.

import type {
	LookupColumnId,
	LookupRowId,
	LookupTableId,
} from "@/lib/domain/lookupIds";
import { coerceLookupCell } from "@/lib/lookup/coercion";
import {
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_BYTES,
} from "@/lib/lookup/constants";
import { formatLookupBytes, formatLookupCount } from "@/lib/lookup/format";
import type {
	CreateLookupRowInput,
	DeleteLookupRowInput,
	LookupCellValue,
	LookupColumn,
	LookupDataType,
	LookupRevision,
	LookupRow,
	LookupRowValues,
	LookupTableSnapshot,
	UpdateLookupRowInput,
} from "@/lib/lookup/types";
import { parseClockTime } from "@/lib/ui/clockTime";

/* Sizes and counts come from `lib/lookup/format`, the same module the
 * service's and the CSV route's refusals use. One formatter means a refusal
 * that says "over the 8 MB limit" and a workspace that says the table holds
 * "8 MB" can never disagree about what a byte count is. Re-exported so the
 * workspace's components have one import for every derivation they render. */
export { formatLookupBytes, formatLookupCount };

/**
 * How full a table is against the two caps that can actually stop a write.
 *
 * Both are reported, because they bind independently: 5,000 short rows hit
 * the row cap with bytes to spare, and 400 long ones hit the byte cap with
 * rows to spare. A surface that shows only one leaves the author guessing
 * which limit refused them.
 */
export interface TableCapacity {
	readonly rowCount: number;
	readonly rowLimit: number;
	readonly dataBytes: number;
	readonly byteLimit: number;
	/** The larger of the two utilizations, 0–1, for one at-a-glance meter. */
	readonly fullness: number;
	/** True once either cap is reached — no further row can be added. */
	readonly full: boolean;
}

export function tableCapacity(table: {
	readonly rowCount: number;
	readonly dataBytes: number;
}): TableCapacity {
	const byRows = table.rowCount / LOOKUP_MAX_ROWS;
	const byBytes = table.dataBytes / LOOKUP_MAX_TABLE_BYTES;
	return {
		rowCount: table.rowCount,
		rowLimit: LOOKUP_MAX_ROWS,
		dataBytes: table.dataBytes,
		byteLimit: LOOKUP_MAX_TABLE_BYTES,
		fullness: Math.min(1, Math.max(byRows, byBytes)),
		full:
			table.rowCount >= LOOKUP_MAX_ROWS ||
			table.dataBytes >= LOOKUP_MAX_TABLE_BYTES,
	};
}

/**
 * Why a table cannot take another row, in the author's words, or
 * `undefined` when it can. Names the measured size against the limit rather
 * than saying "full", so the author knows which one to act on.
 */
export function rowAdditionRefusal(
	capacity: TableCapacity,
): string | undefined {
	if (capacity.rowCount >= capacity.rowLimit) {
		return `This table already holds its limit of ${formatLookupCount(capacity.rowLimit, "row")}. Remove a row, or split the data across two tables.`;
	}
	if (capacity.dataBytes >= capacity.byteLimit) {
		return `This table already holds ${formatLookupBytes(capacity.dataBytes)}, which is its limit of ${formatLookupBytes(capacity.byteLimit)}. Shorten some values, remove a row, or split the data across two tables.`;
	}
	return undefined;
}

/**
 * A legal export name derived from a human label.
 *
 * A suggestion, never an imposition: the field stays editable and stops
 * tracking the label the moment the author types in it. The rule is
 * `LOOKUP_WIRE_IDENTIFIER_PATTERN` — an ASCII letter or underscore, then
 * letters, digits, and underscores — plus the boundary's refusal of anything
 * starting `xml`, so the suggestion is one the server will accept rather than
 * one it will bounce.
 */
export function suggestWireName(label: string): string {
	const ascii = label
		.normalize("NFKD")
		/* Strip combining marks so "Établissement" suggests "etablissement"
		 * rather than losing the whole first letter. */
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (ascii === "") return "";
	const led = /^[a-z_]/.test(ascii) ? ascii : `c_${ascii}`;
	return /^xml/i.test(led) ? `c_${led}` : led;
}

/** The author-facing name of a column's type, in the workspace's vocabulary. */
export const COLUMN_TYPE_LABELS: Readonly<Record<LookupDataType, string>> = {
	text: "Text",
	int: "Whole number",
	decimal: "Decimal number",
	date: "Date",
	time: "Time",
	datetime: "Date and time",
};

/**
 * One cell as text for display.
 *
 * A missing UUID key is a missing cell, and a missing cell is not the empty
 * string — the wire treats both as blank at evaluation, but an author
 * reading a grid needs to see which rows never had a value. The caller
 * decides how to render `undefined`; this function never invents "".
 */
export function cellText(
	values: LookupRowValues,
	column: LookupColumn,
): string | undefined {
	const raw: LookupCellValue | undefined = values[column.id];
	if (raw === undefined) return undefined;
	return typeof raw === "number" ? String(raw) : raw;
}

/**
 * How many rows one page of the grid shows.
 *
 * Matched to the running case list's own page size so the two row surfaces
 * behave alike rather than each picking a number.
 */
export const ROWS_PER_PAGE = 50;

/**
 * The rows whose displayed text contains `query`, in authored order.
 *
 * Matching runs over the SAME text `cellText` renders, so a row a person can
 * see is a row they can find — searching stored values instead would miss a
 * number the grid shows as text, and a missing cell would silently match the
 * empty string. Case-insensitive and whitespace-trimmed; an empty query
 * matches everything rather than nothing.
 */
export function filterRows<Row extends { readonly values: LookupRowValues }>(
	rows: readonly Row[],
	columns: readonly LookupColumn[],
	query: string,
): readonly Row[] {
	const needle = query.trim().toLocaleLowerCase();
	if (needle === "") return rows;
	return rows.filter((row) =>
		columns.some((column) =>
			cellText(row.values, column)?.toLocaleLowerCase().includes(needle),
		),
	);
}

/**
 * One cell being edited: raw text plus the storage projection that cannot be
 * shown in the human-facing control.
 *
 * Time controls show a clock, not an RFC 3339 timezone suffix. Keeping that
 * suffix beside the text lets an unchanged `14:30:00+05:30` round-trip byte for
 * byte and lets an edited clock retain the same offset. A new temporal value
 * gets `Z`, because Nova has no authored app timezone to invent.
 */
export interface RowDraftCell {
	/** `undefined` means the UUID key is absent. `""` is a present empty text
	 * cell, which is legal and must not collapse onto absence. */
	readonly text: string | undefined;
	readonly timezone?: string;
	/** Exact stored spelling for a lossless no-op round trip. */
	readonly originalStored?: string;
	readonly originalText?: string;
}

export type RowDraft = Readonly<Record<LookupColumnId, RowDraftCell>>;

/** A draft turned into stored values, or the reasons it could not be. */
export type RowDraftResult =
	| { readonly ok: true; readonly values: LookupRowValues }
	| {
			readonly ok: false;
			readonly errors: ReadonlyMap<LookupColumnId, string>;
	  };

/** The row as it currently stands, as draft text ready to edit. */
export function rowValuesToDraft(
	values: LookupRowValues,
	columns: readonly LookupColumn[],
): RowDraft {
	const draft: Record<string, RowDraftCell> = {};
	for (const column of columns) {
		const stored = cellText(values, column);
		if (
			stored === undefined ||
			(column.dataType !== "time" && column.dataType !== "datetime")
		) {
			draft[column.id] = { text: stored };
			continue;
		}
		const projected = temporalValueToDraft(stored, column.dataType);
		draft[column.id] = {
			text: projected.text,
			timezone: projected.timezone,
			originalStored: stored,
			originalText: projected.text,
		};
	}
	return draft as RowDraft;
}

/**
 * Parse a draft into stored values.
 *
 * An absent cell stays ABSENT. An authored empty text cell stays `""`, because
 * text storage distinguishes those states; an empty control for every other
 * type means absence, matching an empty CSV cell.
 *
 * A time is parsed through `parseClockTime` first, because the field's value
 * contract is the raw typed clock rather than a wire string; everything else
 * goes straight to `coerceLookupCell`, the SAME validation the server will
 * run, so a value this accepts is a value the write accepts.
 */
export function rowDraftToValues(
	draft: RowDraft,
	columns: readonly LookupColumn[],
): RowDraftResult {
	const values: Record<string, string | number> = {};
	const errors = new Map<LookupColumnId, string>();
	for (const column of columns) {
		const cell = draft[column.id];
		if (cell === undefined || cell.text === undefined) continue;
		const raw = cell.text;
		/* An empty string is a real, valid text value. Every other empty
		 * control means the UUID key is absent. RowValueField normally encodes
		 * that distinction directly; this branch keeps programmatic drafts
		 * honest too. */
		if (raw === "" && column.dataType !== "text") continue;
		if (column.dataType === "time" || column.dataType === "datetime") {
			const parsed = parseTemporalText(raw, column.dataType, cell);
			if (parsed === null) {
				errors.set(
					column.id,
					column.dataType === "time"
						? "Enter a time like 2:30 PM. Nova saves it with a timezone."
						: "Enter both a date and a time. Nova saves it with a timezone.",
				);
				continue;
			}
			values[column.id] = parsed;
			continue;
		}
		const coerced = coerceLookupCell(
			column.dataType,
			raw,
			column.dataType === "text" ? "typed" : "csv",
		);
		if (!coerced.success) {
			errors.set(column.id, coerced.message);
			continue;
		}
		values[column.id] = coerced.value;
	}
	return errors.size > 0
		? { ok: false, errors }
		: { ok: true, values: values as LookupRowValues };
}

/** Split a stored temporal value into the clock a person edits and the exact
 * timezone suffix storage requires. */
function temporalValueToDraft(
	stored: string,
	dataType: "time" | "datetime",
): { readonly text: string; readonly timezone: string } {
	const match = /^(.*?)(z|[+-]\d{2}(?::?\d{2})?)$/i.exec(stored);
	if (match === null) return { text: stored, timezone: "Z" };
	const withoutZone = match[1];
	const timezone = match[2];
	if (dataType === "time") return { text: withoutZone, timezone };
	const separator = /[t\s]/i.exec(withoutZone);
	if (separator === null) return { text: withoutZone, timezone };
	return {
		text: `${withoutZone.slice(0, separator.index)}T${withoutZone.slice(
			separator.index + 1,
		)}`,
		timezone,
	};
}

/** A typed clock, or a `date` + typed clock, in RFC 3339 storage spelling. */
function parseTemporalText(
	raw: string,
	dataType: "time" | "datetime",
	cell: RowDraftCell,
): string | null {
	if (
		cell.originalStored !== undefined &&
		cell.originalText !== undefined &&
		raw === cell.originalText
	) {
		/* The stored value already passed the strict lookup schema. Returning it
		 * unchanged preserves offset spelling, fractional seconds, and `Z`. */
		return cell.originalStored;
	}
	const timezone = cell.timezone ?? "Z";
	if (dataType === "time") {
		const time = parseClockTime(raw);
		return time === null ? null : `${time}${timezone}`;
	}
	const [datePart, timePart] = raw.split("T");
	if (datePart === undefined || timePart === undefined) return null;
	const time = parseClockTime(timePart);
	if (time === null) return null;
	const candidate = `${datePart}T${time}${timezone}`;
	const checked = coerceLookupCell("datetime", candidate, "typed");
	return checked.success ? candidate : null;
}

/**
 * Immutable row edit-session baseline.
 *
 * A realtime refresh may replace the displayed table snapshot while a draft is
 * open. Capturing the full row, columns, and optimistic revision here keeps the
 * eventual Save comparing against what the author actually began from rather
 * than silently adopting the peer's newer generation.
 */
export interface RowEditBaseline {
	readonly tableRevision: LookupTableSnapshot["tableRevision"];
	readonly row: LookupRow;
	readonly columns: readonly LookupColumn[];
}

export function captureRowEditBaseline(
	table: LookupTableSnapshot,
	row: LookupRow,
): RowEditBaseline {
	return {
		tableRevision: table.tableRevision,
		row: { ...row, values: { ...row.values } as LookupRowValues },
		columns: table.columns.map((column) => ({ ...column })),
	};
}

/** The exact fresh generation rendered on a row-conflict decision surface. */
export interface RowConflictResolutionTarget {
	readonly tableRevision: LookupRevision;
	readonly rowCount: number;
}

/** Build explicit conflict-resolution writes from the reviewed generation.
 *
 * Keeping these pure makes two guarantees independently testable: "Keep mine"
 * never falls back to the stale edit-session revision, and "Save as a new row"
 * appends against the row count the author actually reviewed. */
export function conflictOverwriteInput(args: {
	readonly tableId: LookupTableId;
	readonly rowId: LookupRowId;
	readonly draft: LookupRowValues;
	readonly resolution: RowConflictResolutionTarget;
}): UpdateLookupRowInput {
	return {
		tableId: args.tableId,
		expectedTableRevision: args.resolution.tableRevision,
		rowId: args.rowId,
		values: args.draft,
	};
}

export function conflictSaveAsNewInput(args: {
	readonly tableId: LookupTableId;
	readonly draft: LookupRowValues;
	readonly resolution: RowConflictResolutionTarget;
}): CreateLookupRowInput {
	return {
		tableId: args.tableId,
		expectedTableRevision: args.resolution.tableRevision,
		toIndex: args.resolution.rowCount,
		values: args.draft,
	};
}

export function conflictDeleteInput(args: {
	readonly tableId: LookupTableId;
	readonly rowId: LookupRowId;
	readonly resolution: RowConflictResolutionTarget;
}): DeleteLookupRowInput {
	return {
		tableId: args.tableId,
		expectedTableRevision: args.resolution.tableRevision,
		rowId: args.rowId,
	};
}

/**
 * A text setting edited against one optimistic table generation.
 *
 * `latest*` follows realtime truth while `baseRevision` stays the generation a
 * Save is allowed to use. A dirty draft is never silently rebased: if a peer
 * advances the table, the author must adopt the fresh text or explicitly keep
 * theirs against the newly reviewed generation.
 */
export interface RevisionedTextDraft {
	readonly text: string;
	readonly baseText: string;
	readonly baseRevision: LookupRevision;
	readonly latestText: string;
	readonly latestRevision: LookupRevision;
	readonly dirty: boolean;
	readonly conflicted: boolean;
}

export function createRevisionedTextDraft(
	text: string,
	revision: LookupRevision,
): RevisionedTextDraft {
	return {
		text,
		baseText: text,
		baseRevision: revision,
		latestText: text,
		latestRevision: revision,
		dirty: false,
		conflicted: false,
	};
}

export function editRevisionedTextDraft(
	draft: RevisionedTextDraft,
	text: string,
): RevisionedTextDraft {
	if (text === draft.latestText) {
		return createRevisionedTextDraft(draft.latestText, draft.latestRevision);
	}
	return { ...draft, text, dirty: text !== draft.baseText };
}

export function reconcileRevisionedTextDraft(
	draft: RevisionedTextDraft,
	latestText: string,
	latestRevision: LookupRevision,
): RevisionedTextDraft {
	if (
		latestRevision === draft.latestRevision &&
		latestText === draft.latestText
	) {
		return draft;
	}
	if (!draft.dirty || draft.text === latestText) {
		return createRevisionedTextDraft(latestText, latestRevision);
	}
	return {
		...draft,
		latestText,
		latestRevision,
		conflicted: true,
	};
}

export function keepRevisionedTextDraft(
	draft: RevisionedTextDraft,
): RevisionedTextDraft {
	return {
		...draft,
		baseText: draft.latestText,
		baseRevision: draft.latestRevision,
		dirty: draft.text !== draft.latestText,
		conflicted: false,
	};
}

export function discardRevisionedTextDraft(
	draft: RevisionedTextDraft,
): RevisionedTextDraft {
	return createRevisionedTextDraft(draft.latestText, draft.latestRevision);
}

/**
 * Whether two rows carry the same stored cells.
 *
 * This is the question the conflict policy turns on: an optimistic-revision
 * mismatch means SOMETHING in the table changed, and comparing the row the
 * author started from against the row the server now holds is what separates
 * "a co-member edited a different row" from "a co-member edited this one".
 * Key order is irrelevant — the stored object is a UUID-keyed map.
 */
export function rowValuesEqual(
	left: LookupRowValues,
	right: LookupRowValues,
): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every(
		(key) =>
			Object.hasOwn(right, key) &&
			left[key as keyof LookupRowValues] ===
				right[key as keyof LookupRowValues],
	);
}

/**
 * What the workspace does with a write the server refused on revision drift.
 *
 * A lookup table's optimistic token is `max(definitionRevision, rowsRevision)`,
 * so ANY concurrent change to the table invalidates it — including one to a
 * row the author never touched. Treating every drift as a conflict a human
 * must resolve would put a dialog in front of edits that do not conflict at
 * all; silently retrying every drift would let one author's save overwrite a
 * co-member's edit to the same row. The rule is the middle: retry
 * automatically only when the fresh state proves the author's edit is still
 * the same edit, and otherwise show both values and let them choose.
 */
export type ConflictVerdict =
	/** Nobody touched what this write is about — resend against the fresh
	 *  revision. The author sees a save that took a moment longer. */
	| { readonly kind: "retry" }
	/** The write's subject changed underneath. The author's draft is kept and
	 *  presented beside the stored value. */
	| { readonly kind: "ask"; readonly reason: ConflictReason }
	/** The write's subject is gone. There is nothing to overwrite and nothing
	 *  to compare, so the draft is offered as a new row instead. */
	| { readonly kind: "gone" };

export type ConflictReason =
	| "row-changed"
	| "columns-changed"
	| "table-replaced";

/**
 * Decide what to do about a refused single-row write.
 *
 * `baseline` is the row as it stood when the author began editing; `current`
 * is the row the freshly re-read table now holds. `columnsChanged` covers the
 * definition axis — a retype or a removed column changes what the author's
 * draft even means, so it is never resent without asking.
 */
export function rowWriteConflictVerdict(args: {
	readonly baseline: LookupRowValues;
	readonly current: LookupRow | undefined;
	readonly columnsChanged: boolean;
}): ConflictVerdict {
	if (args.current === undefined) return { kind: "gone" };
	if (args.columnsChanged) {
		return { kind: "ask", reason: "columns-changed" };
	}
	return rowValuesEqual(args.baseline, args.current.values)
		? { kind: "retry" }
		: { kind: "ask", reason: "row-changed" };
}

/**
 * Decide what to do about a refused whole-table replacement (a CSV import).
 *
 * Never `retry`. A replacement discards every existing row by definition, so
 * "the table changed underneath" is exactly the case where resending would
 * destroy the change. The author re-confirms against what the table now
 * holds.
 */
export function replacementConflictVerdict(): ConflictVerdict {
	return { kind: "ask", reason: "table-replaced" };
}

/** Whether two column lists are the same definition, in the same order. */
export function columnsEqual(
	left: readonly LookupColumn[],
	right: readonly LookupColumn[],
): boolean {
	return (
		left.length === right.length &&
		left.every((column, index) => {
			const other = right[index];
			return (
				column.id === other.id &&
				column.wireName === other.wireName &&
				column.label === other.label &&
				column.dataType === other.dataType
			);
		})
	);
}
