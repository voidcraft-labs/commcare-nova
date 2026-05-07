// components/builder/case-list-config/columnCellRenderer.tsx
//
// Shared per-cell render helpers for both case-list authoring-
// surface previews. The Display section's preview AND the Filters
// section's preview render the same column shapes against the
// same `CaseRow`/`CalculatedValue` data; centralizing the
// per-kind switch keeps the two previews visually consistent and
// avoids the kind-by-kind drift that copy-paste would invite.
//
// Each column kind has its own render path. The runtime / wire-
// emit layers handle the same logic against the live engine; the
// preview reads off the already-loaded `CaseRow` and applies a
// best-effort formatter that mirrors the runtime's intent. Date /
// phone / id-mapping / late-flag formatting is intentionally
// simple here — the goal is "what does this look like", not
// "exact wire parity". The preview pins the column's authored
// shape; small format drift against CCHQ's runtime is acceptable
// for an authoring-time preview.

"use client";
import type { CalculatedValue, CaseRow } from "@/lib/case-store";
import type { Column } from "@/lib/domain";
import { caseRowDisplayValue } from "@/lib/preview/engine/caseDataBindingHelpers";

/**
 * Render one column's cell for one row. Dispatches on the
 * column's `kind` discriminator; each branch handles the
 * authored shape with a best-effort runtime-mirroring format.
 *
 * The exhaustive `switch` forces a branch per kind — adding a
 * new column kind to the discriminated union surfaces here as a
 * type error first, not a silent rendering regression.
 */
export function renderColumnCell(
	column: Column,
	row: CaseRow,
): React.ReactNode {
	const raw = caseRowDisplayValue(row, column.field);
	switch (column.kind) {
		case "plain":
			return <span>{raw || "—"}</span>;
		case "phone":
			// Phone column renders as a tappable link in the runtime.
			// The preview shows the raw value with monospace styling
			// to communicate "this is a phone-typed column" without
			// pretending to format an arbitrary international number.
			return raw ? <span className="font-mono">{raw}</span> : <span>—</span>;
		case "date":
			// The runtime applies the column's `pattern` via CCHQ's
			// format-date function. The preview tries an ISO parse
			// and renders the JS-formatted local date as a best-
			// effort fallback; un-parseable values show raw.
			return <span>{formatDateBestEffort(raw, column.pattern)}</span>;
		case "time-since-until":
			return <span>{formatTimeSinceBestEffort(raw, column)}</span>;
		case "late-flag":
			return <span>{formatLateFlagBestEffort(raw, column)}</span>;
		case "id-mapping": {
			const match = column.mapping.find((entry) => entry.value === raw);
			return <span>{match?.label ?? raw ?? "—"}</span>;
		}
		case "search-only":
			// Search-only columns aren't displayed; the parent filters
			// them out before reaching the cell renderer. This branch
			// is structurally unreachable but kept for exhaustivity —
			// the discriminated union forces a branch per kind.
			return null;
	}
}

/**
 * Render a calculated column's value. The case-store returns each
 * value typed per the SQL expression's resolved Postgres type:
 *
 *   - **text** → JS string
 *   - **integer** → JS number
 *   - **numeric** (decimal) → JS string (pg's arbitrary-precision
 *     deserializer hands these back as strings to avoid lossy
 *     IEEE-754 round-tripping)
 *   - **boolean** → JS boolean
 *   - **date** / **timestamptz** → JS Date object (NOT an ISO
 *     string — pg's per-OID deserializer materializes the typed
 *     value)
 *   - **jsonb** → JS object / array (pg's JSONB deserializer
 *     parses the wire payload)
 *
 * The Date arm needs an explicit branch because `JSON.stringify(date)`
 * emits a quoted ISO string (`"2026-05-06T00:00:00.000Z"`) — visible
 * quotes in the rendered cell. Routing Dates through `toISOString()`
 * and stripping the time when present gives the user a clean
 * authoring-time hint of the value's shape.
 *
 * The contract test
 * `lib/case-store/__tests__/storeContract.ts → "returns a Date object
 * for a date-typed calculated expression"` pins the Date arm; a
 * regression to a string-shaped date would break the test, surfacing
 * the renderer's coupling to pg-driver behavior.
 */
export function renderCalculatedCell(
	value: CalculatedValue | undefined,
): React.ReactNode {
	if (value === undefined || value === null) return <span>—</span>;
	if (value instanceof Date) {
		// `toISOString()` always produces `YYYY-MM-DDTHH:MM:SS.sssZ`.
		// Date-typed columns lose the time component on the wire
		// boundary; the resulting Date in JS lands at midnight UTC,
		// so trimming `T...Z` gives the calendar-date display the
		// authoring preview wants. Datetime-typed columns keep the
		// full ISO string so the user sees the time component too.
		const iso = value.toISOString();
		// Heuristic: midnight UTC means a date-shaped value (the wire
		// `date` -> JS Date adapter zeroes the time component); any
		// non-midnight time means the column carries time-of-day.
		const isMidnight = iso.endsWith("T00:00:00.000Z");
		return <span>{isMidnight ? iso.slice(0, 10) : iso}</span>;
	}
	if (typeof value === "string") return <span>{value || "—"}</span>;
	if (typeof value === "number" || typeof value === "boolean") {
		return <span>{String(value)}</span>;
	}
	// Arrays / objects — JSONB columns. Stringify for inspection;
	// the preview's calculated-column cell is monospace by default
	// so the JSON shape stays readable.
	return <span>{JSON.stringify(value)}</span>;
}

// ── Best-effort formatters ────────────────────────────────────────

/**
 * Best-effort ISO-string parser + locale-formatted renderer. The
 * authoring preview prioritizes "this looks date-shaped" over exact
 * CCHQ wire-format parity — the wire emitter applies the column's
 * `pattern` via Postgres's `to_char`. Falls back to the raw value
 * when the parse fails so authoring continues unimpeded.
 *
 * The `_pattern` parameter is unused at the rendering layer; the
 * preview's locale-format shape is the chosen approximation. The
 * full pattern lives on the column for the wire emitter to honor.
 */
function formatDateBestEffort(raw: string, _pattern: string): string {
	if (!raw) return "—";
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) return raw;
	return parsed.toLocaleDateString();
}

/**
 * Best-effort time-since renderer. The runtime computes
 * `(today() - propValue)` in the column's unit and surfaces the
 * displayLabel when the threshold is exceeded. The preview shows
 * the raw value's relative interval ("3 days ago") without the
 * threshold-exceeded label — the goal is to communicate the column
 * kind, not replicate the runtime exactly.
 */
function formatTimeSinceBestEffort(
	raw: string,
	column: Extract<Column, { kind: "time-since-until" }>,
): string {
	if (!raw) return "—";
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) return raw;
	const now = new Date();
	const diffMs = now.getTime() - parsed.getTime();
	const dayMs = 1000 * 60 * 60 * 24;
	const diffDays = Math.floor(Math.abs(diffMs) / dayMs);
	const sign = diffMs < 0 ? "in " : "";
	const past = diffMs >= 0 ? " ago" : "";
	const value =
		column.unit === "weeks"
			? Math.floor(diffDays / 7)
			: column.unit === "months"
				? Math.floor(diffDays / 30)
				: column.unit === "years"
					? Math.floor(diffDays / 365)
					: diffDays;
	return `${sign}${value} ${column.unit}${past}`;
}

/**
 * Best-effort late-flag renderer. The runtime surfaces
 * `flagDisplayValue` when the date property exceeds the threshold;
 * the preview applies the same logic locally so the column's
 * authored shape is visible.
 */
function formatLateFlagBestEffort(
	raw: string,
	column: Extract<Column, { kind: "late-flag" }>,
): string {
	if (!raw) return "";
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) return "";
	const now = new Date();
	const diffMs = now.getTime() - parsed.getTime();
	const dayMs = 1000 * 60 * 60 * 24;
	const diffDays = Math.floor(diffMs / dayMs);
	const thresholdDays =
		column.unit === "weeks"
			? column.threshold * 7
			: column.unit === "months"
				? column.threshold * 30
				: column.unit === "years"
					? column.threshold * 365
					: column.threshold;
	return diffDays > thresholdDays ? column.flagDisplayValue : "";
}
