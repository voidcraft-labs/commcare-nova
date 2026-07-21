// The data review screen's state model — pure functions over the
// Server Action's wire entries (`ParkedValueEntryWire`), kept free of
// React so the case grouping, filter partition, and draft
// normalization unit-test directly. The component renders this model;
// it never re-derives a verdict (those are computed server-side
// against the property's current declaration).

import type {
	CasePropertyDataType,
	JsonValue,
	ParkedValueEntryWire,
	ParkedValueStanding,
} from "@/lib/preview/engine/caseDataBindingTypes";
import { parseClockTime } from "@/lib/ui/clockTime";

/**
 * The two filter pills. "Ready to review" is the ACTIVE list
 * (undismissed); "Dismissed" is the soft archive. An entry is in
 * exactly one of the two, so the pills partition the list.
 */
export type ReviewFilter = "ready" | "dismissed";

export interface ReviewCounts {
	readonly ready: number;
	readonly dismissed: number;
}

export function reviewCounts(
	entries: readonly ParkedValueEntryWire[],
): ReviewCounts {
	let dismissed = 0;
	for (const entry of entries) {
		if (entry.dismissedAt !== null) dismissed++;
	}
	return { ready: entries.length - dismissed, dismissed };
}

/**
 * Distinct cases the active (undismissed) entries HOLD out of the
 * running app. The discovery surfaces (the Case data badge/popover)
 * speak in cases — that is the unit the app is missing.
 */
export function heldCaseCount(
	entries: readonly ParkedValueEntryWire[],
): number {
	const held = new Set<string>();
	for (const entry of entries) {
		if (entry.dismissedAt === null) held.add(entry.caseId);
	}
	return held.size;
}

export function filterReviewEntries(
	entries: readonly ParkedValueEntryWire[],
	filter: ReviewFilter,
): ParkedValueEntryWire[] {
	switch (filter) {
		case "ready":
			return entries.filter((entry) => entry.dismissedAt === null);
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
 * Person-facing spelling for each data type — the chip icon's
 * screen-reader name reads these instead of the wire tokens
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
 * A stored value rendered for a row — arrays (multi-select originals)
 * read as their comma-separated selections, everything else as its
 * plain string form.
 */
export function displayReviewValue(value: JsonValue): string {
	if (Array.isArray(value)) return value.map(String).join(", ");
	return String(value);
}

/**
 * The row's one-clause story: why this value is waiting, told
 * against the property's CURRENT state — the server's `standing`
 * classification carries the fact, this maps it to words. The
 * blocked arm names what the value fails to be ("Isn’t a date"
 * beside the literal "next Tuesday" and the date-iconed chip is the
 * whole event). A select block is always a SHAPE mismatch — the
 * stored select schema carries no option enum (a narrowed-away value
 * stands `fits`; its case is held, so nothing else claims the slot),
 * so the only way a select declaration rejects a value is a list
 * where a single choice goes or vice versa. `currentType` comes from
 * the same declaration the chip icon reads, so the phrase and the
 * icon can't disagree; when the client can't see a declaration for a
 * blocked entry (a schema materialization beat), the phrase stays
 * typeless rather than guessing.
 */
export function standingPhrase(
	standing: ParkedValueStanding,
	currentType: CasePropertyDataType | undefined,
): string {
	switch (standing) {
		case "fits":
			return "Fits the property again";
		case "undeclared":
			return "The property was removed";
		case "blocked": {
			if (currentType === undefined) return "Doesn’t fit the property now";
			if (currentType === "single_select") return "Isn’t a single choice";
			if (currentType === "multi_select") return "Isn’t a list of choices";
			const label = DATA_TYPE_LABELS[currentType];
			return currentType === "text" ? "Isn’t text" : `Isn’t a ${label}`;
		}
	}
}

/**
 * Normalize a Replace-editor draft into the typed value the property's
 * CURRENT declaration stores, or report it not-submittable (empty,
 * malformed, or a shape the control can't hand over). The temporal
 * arms stamp the explicit UTC designator the strict row schema
 * requires (`format: "time"` / `"date-time"` demand an offset; Nova
 * authors no app timezone, so an offset-less value reads as UTC — the
 * same stance the cast matrix and the sample generator take), and
 * they parse strictly because the time half is HAND-TYPED (the date
 * half comes from the Calendar picker as `YYYY-MM-DD`). The server's
 * schema validation remains the authority — a value this function
 * admits can still come back as the typed `invalid-value` arm (e.g. a
 * geopoint that misses the pattern).
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
			const clock = parseClockTime(text);
			if (clock === null) return { ok: false };
			return { ok: true, value: `${clock}Z` };
		}
		case "datetime": {
			// The draft carries `<calendar date>T<typed time>`; either half
			// may still be pending, and a pending half is not submittable.
			const match = /^(\d{4}-\d{2}-\d{2})T(.+)$/.exec(text);
			if (match === null) return { ok: false };
			const clock = parseClockTime(match[2] as string);
			if (clock === null) return { ok: false };
			return { ok: true, value: `${match[1]}T${clock}Z` };
		}
		case "multi_select":
			return { ok: false };
		default:
			return { ok: true, value: text };
	}
}
