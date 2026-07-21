// The data review screen's state model — pure functions over the
// Server Action's wire entries (`ParkedValueEntryWire`), kept free of
// React so the case grouping, filter partition, notice conditions, and
// draft normalization unit-test directly. The component renders this
// model; it never re-derives a verdict (those are computed server-side
// against the property's current declaration).

import type {
	CasePropertyDataType,
	JsonValue,
	ParkedValueEntryWire,
} from "@/lib/preview/engine/caseDataBindingTypes";

/**
 * The three filter pills. "All" is the ACTIVE list (undismissed);
 * "Dismissed" is the soft archive — an entry is in exactly one of the
 * two, so the pills partition rather than overlap ("Ready" narrows the
 * active list to what a put-back would accept right now).
 */
export type ReviewFilter = "all" | "ready" | "dismissed";

export interface ReviewCounts {
	readonly all: number;
	readonly ready: number;
	readonly dismissed: number;
}

export function reviewCounts(
	entries: readonly ParkedValueEntryWire[],
): ReviewCounts {
	let ready = 0;
	let dismissed = 0;
	for (const entry of entries) {
		if (entry.dismissedAt !== null) dismissed++;
		else if (entry.restorable) ready++;
	}
	return { all: entries.length - dismissed, ready, dismissed };
}

export function filterReviewEntries(
	entries: readonly ParkedValueEntryWire[],
	filter: ReviewFilter,
): ParkedValueEntryWire[] {
	switch (filter) {
		case "all":
			return entries.filter((entry) => entry.dismissedAt === null);
		case "ready":
			return entries.filter(
				(entry) => entry.dismissedAt === null && entry.restorable,
			);
		case "dismissed":
			return entries.filter((entry) => entry.dismissedAt !== null);
	}
}

/**
 * One card on the review screen: a CASE and the values it's waiting
 * on. The case is the anchor — people review records, not floating
 * values — and each row under it names the property, the value, and
 * what can happen next. Cards order by case name so the list reads
 * like a roster; rows order by property name for a stable scan.
 */
export interface ReviewCaseGroup {
	readonly caseId: string;
	readonly caseName: string;
	readonly entries: readonly ParkedValueEntryWire[];
}

export function groupReviewByCase(
	entries: readonly ParkedValueEntryWire[],
): ReviewCaseGroup[] {
	const byCase = new Map<string, ParkedValueEntryWire[]>();
	for (const entry of entries) {
		const bucket = byCase.get(entry.caseId);
		if (bucket === undefined) byCase.set(entry.caseId, [entry]);
		else bucket.push(entry);
	}
	return [...byCase.values()]
		.map((bucket) => ({
			caseId: (bucket[0] as ParkedValueEntryWire).caseId,
			caseName: (bucket[0] as ParkedValueEntryWire).caseName,
			entries: [...bucket].sort((a, b) => a.property.localeCompare(b.property)),
		}))
		.sort(
			(a, b) =>
				a.caseName.localeCompare(b.caseName) ||
				a.caseId.localeCompare(b.caseId),
		);
}

/**
 * One property-level notice above the case list: every active value of
 * this property is blocked by its CURRENT type, and at least one still
 * fits the type it was saved under — so converting the property back
 * is a real way out, alongside replacing each value. Derived from the
 * ACTIVE entries only; a type change with any ready or occupied value
 * gets no notice (those rows already offer their own actions).
 */
export interface ConvertBackNotice {
	readonly property: string;
	readonly fromType: CasePropertyDataType;
	readonly toType: CasePropertyDataType;
	readonly count: number;
}

export function convertBackNotices(
	entries: readonly ParkedValueEntryWire[],
): ConvertBackNotice[] {
	const byTransition = new Map<string, ParkedValueEntryWire[]>();
	for (const entry of entries) {
		if (entry.dismissedAt !== null) continue;
		if (entry.fromType === entry.toType) continue;
		const key = `${entry.property}|${entry.fromType}|${entry.toType}`;
		const bucket = byTransition.get(key);
		if (bucket === undefined) byTransition.set(key, [entry]);
		else bucket.push(entry);
	}
	const notices: ConvertBackNotice[] = [];
	for (const bucket of byTransition.values()) {
		const allBlockedByType = bucket.every(
			(entry) => entry.blockedBy === "type",
		);
		const anyFitsOriginal = bucket.some((entry) => entry.fitsOriginalType);
		if (!allBlockedByType || !anyFitsOriginal) continue;
		const first = bucket[0] as ParkedValueEntryWire;
		notices.push({
			property: first.property,
			fromType: first.fromType,
			toType: first.toType,
			count: bucket.length,
		});
	}
	return notices.sort((a, b) => a.property.localeCompare(b.property));
}

/** Ids a put-back would accept right now, across the active list. */
export function readyIds(entries: readonly ParkedValueEntryWire[]): string[] {
	return entries
		.filter((entry) => entry.dismissedAt === null && entry.restorable)
		.map((entry) => entry.id);
}

/**
 * Person-facing spelling for each data type — statuses, notices, and
 * the chat prefill all read these instead of the wire tokens
 * (`single_select` is authoring vocabulary, not user vocabulary).
 */
export const DATA_TYPE_LABELS: Record<CasePropertyDataType, string> = {
	text: "text",
	int: "whole number",
	decimal: "decimal",
	date: "date",
	time: "time",
	datetime: "date & time",
	single_select: "select",
	multi_select: "multi-select",
	geopoint: "GPS point",
};

/**
 * The label with its natural article, for running prose ("fits a
 * date", "fits text") — "text" is a mass noun; every other type label
 * counts.
 */
export function dataTypePhrase(dataType: CasePropertyDataType): string {
	const label = DATA_TYPE_LABELS[dataType];
	return dataType === "text" ? label : `a ${label}`;
}

/**
 * A stored value rendered for a row — arrays (multi-select originals)
 * read as their comma-separated selections, everything else as its
 * plain string form.
 */
export function displayReviewValue(value: JsonValue): string {
	if (Array.isArray(value)) return value.map(String).join(", ");
	return String(value);
}

/**
 * Normalize a Replace-editor draft into the typed value the property's
 * CURRENT declaration stores, or report it not-submittable (empty /
 * shape the widget can't hand over). The temporal arms stamp the
 * explicit UTC designator the strict row schema requires
 * (`format: "time"` / `"date-time"` demand an offset; Nova authors no
 * app timezone, so an offset-less widget value reads as UTC — the
 * same stance the cast matrix and the sample generator take). The
 * server's schema validation remains the authority — a value this
 * function admits can still come back as the typed `invalid-value`
 * arm (e.g. a geopoint that misses the pattern).
 */
export function replacementDraftToValue(
	dataType: CasePropertyDataType,
	draft: string | readonly string[],
): { ok: true; value: JsonValue } | { ok: false } {
	if (Array.isArray(draft)) {
		if (dataType !== "multi_select" || draft.length === 0) return { ok: false };
		return { ok: true, value: [...draft] };
	}
	const text = (draft as string).trim();
	if (text === "") return { ok: false };
	switch (dataType) {
		case "int": {
			if (!/^-?\d+$/.test(text)) return { ok: false };
			return { ok: true, value: Number(text) };
		}
		case "decimal": {
			if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false };
			return { ok: true, value: Number(text) };
		}
		case "time": {
			// Native <input type="time"> yields HH:MM or HH:MM:SS.
			const withSeconds = /^\d{2}:\d{2}$/.test(text) ? `${text}:00` : text;
			return { ok: true, value: `${withSeconds}Z` };
		}
		case "datetime": {
			// Native <input type="datetime-local"> yields
			// YYYY-MM-DDTHH:MM or …:SS.
			const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)
				? `${text}:00`
				: text;
			return { ok: true, value: `${withSeconds}Z` };
		}
		case "multi_select":
			return { ok: false };
		default:
			return { ok: true, value: text };
	}
}
