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
// best-effort formatter that mirrors the runtime's intent.
// Date / phone / id-mapping / interval formatting is intentionally
// simple here — the goal is "what does this look like", not
// "exact wire parity". The preview pins the column's authored
// shape; small format drift against CCHQ's runtime is acceptable
// for an authoring-time preview.
//
// Calculated columns project their result through the case-store's
// `query` SELECT slot (under the optional `calculated` projection
// arg); the value lands on `row.calculated[col.uuid]` per the v2
// case-store contract. The dispatcher reads the slot and routes
// through `renderCalculatedCell`.

"use client";
import type { Column } from "@/lib/domain";
import { caseRowDisplayValue } from "@/lib/preview/engine/caseDataBindingClient";
import type {
	CalculatedValue,
	CaseRowWithCalculated,
} from "@/lib/preview/engine/caseDataBindingTypes";

/**
 * Render one column's cell for one row. Dispatches on the
 * column's `kind` discriminator; each branch handles the
 * authored shape with a best-effort runtime-mirroring format.
 *
 * The exhaustive `switch` forces a branch per kind — adding a
 * new column kind to the discriminated union surfaces here as a
 * type error first, not a silent rendering regression.
 *
 * Calculated arm reads `row.calculated[column.uuid]` — the case-
 * store's `query` keys results by the column's uuid (the wire-side
 * stable handle). Other arms read the case property named by
 * `column.field` via the shared display-value helper.
 */
export function renderColumnCell(
	column: Column,
	row: CaseRowWithCalculated,
): React.ReactNode {
	switch (column.kind) {
		case "plain": {
			const raw = caseRowDisplayValue(row, column.field);
			return <span>{raw || "—"}</span>;
		}
		case "phone": {
			// Phone column renders as a tappable link in the runtime.
			// The preview shows the raw value with monospace styling
			// to communicate "this is a phone-typed column" without
			// pretending to format an arbitrary international number.
			const raw = caseRowDisplayValue(row, column.field);
			return raw ? <span className="font-mono">{raw}</span> : <span>—</span>;
		}
		case "date": {
			// The runtime applies the column's `pattern` via CCHQ's
			// format-date function. The preview tries an ISO parse
			// and renders the JS-formatted local date as a best-
			// effort fallback; un-parseable values show raw.
			const raw = caseRowDisplayValue(row, column.field);
			return <span>{formatDateBestEffort(raw)}</span>;
		}
		case "interval": {
			const raw = caseRowDisplayValue(row, column.field);
			return <span>{formatIntervalBestEffort(raw, column)}</span>;
		}
		case "id-mapping": {
			const raw = caseRowDisplayValue(row, column.field);
			const match = column.mapping.find((entry) => entry.value === raw);
			return <span>{match?.label ?? raw ?? "—"}</span>;
		}
		case "calculated":
			return renderCalculatedCell(row.calculated[column.uuid]);
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
 */
function formatDateBestEffort(raw: string): string {
	if (!raw) return "—";
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) return raw;
	return parsed.toLocaleDateString();
}

/**
 * Best-effort interval renderer. Dispatches on the column's
 * `display` discriminator:
 *
 *   - `"always"` — render the relative interval ("3 days ago").
 *     The `text` slot's runtime decoration on threshold-exceeded
 *     rows is omitted in the preview — "this is an interval column"
 *     is the communication goal.
 *   - `"flag"` — render the `text` slot when the interval has
 *     crossed the threshold; otherwise empty cell.
 *
 * The threshold is interpreted in the column's unit; the preview
 * uses approximate calendar conversions (1 week = 7 days, 1 month
 * = 30 days, 1 year = 365 days) so the user sees the row's
 * approximate state. The wire layer's exact calendar arithmetic is
 * the runtime authority.
 */
function formatIntervalBestEffort(
	raw: string,
	column: Extract<Column, { kind: "interval" }>,
): string {
	if (!raw) return column.display === "flag" ? "" : "—";
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) {
		return column.display === "flag" ? "" : raw;
	}
	const now = new Date();
	const diffMs = now.getTime() - parsed.getTime();
	const dayMs = 1000 * 60 * 60 * 24;
	const diffDaysAbs = Math.floor(Math.abs(diffMs) / dayMs);
	const thresholdDays =
		column.unit === "weeks"
			? column.threshold * 7
			: column.unit === "months"
				? column.threshold * 30
				: column.unit === "years"
					? column.threshold * 365
					: column.threshold;
	if (column.display === "flag") {
		return Math.floor(diffMs / dayMs) > thresholdDays ? column.text : "";
	}
	// `display === "always"` — render the relative interval.
	const sign = diffMs < 0 ? "in " : "";
	const past = diffMs >= 0 ? " ago" : "";
	const value =
		column.unit === "weeks"
			? Math.floor(diffDaysAbs / 7)
			: column.unit === "months"
				? Math.floor(diffDaysAbs / 30)
				: column.unit === "years"
					? Math.floor(diffDaysAbs / 365)
					: diffDaysAbs;
	return `${sign}${value} ${column.unit}${past}`;
}
