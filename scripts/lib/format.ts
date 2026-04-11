/**
 * Formatting utilities for diagnostic script output.
 *
 * All display formatting lives here — table rendering, section headers,
 * number formatting, and truncation. Scripts import what they need from
 * this module; no script should define its own formatting functions.
 */

// ── Number formatters ───────────────────────────────────────────────

/** Format a number with comma separators (e.g. 1,234,567). */
export function tok(n: number): string {
	return n.toLocaleString("en-US");
}

/** Format a cost value as a USD string (e.g. "$1.2345"). */
export function usd(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

/**
 * Format a percentage from a numerator/denominator pair.
 * Returns "—" when the denominator is zero (avoids division by zero).
 */
export function pct(numerator: number, denominator: number): string {
	if (denominator === 0) return "—";
	return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * Examples: "13m 25s", "2m 5s", "45s"
 */
export function duration(ms: number): string {
	const totalSec = Math.round(ms / 1000);
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min === 0) return `${sec}s`;
	return `${min}m ${sec}s`;
}

// ── String helpers ──────────────────────────────────────────────────

/** Truncate a string for display, appending "…" if trimmed. */
export function truncate(str: string, maxLen = 120): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen)}…`;
}

/** Firestore Timestamp → ISO string, with fallback for missing values. */
export function tsToISO(ts: { toDate(): Date } | undefined | null): string {
	return ts?.toDate?.().toISOString() ?? "(missing)";
}

// ── Section chrome ──────────────────────────────────────────────────

/** Print a boxed header banner (the "═══" style). */
export function printHeader(title: string): void {
	const padded = `  ${title}`;
	/* Ensure the box is at least 58 chars wide for consistency. */
	const width = Math.max(58, padded.length + 2);
	console.log(`╔${"═".repeat(width)}╗`);
	console.log(`║${padded.padEnd(width)}║`);
	console.log(`╚${"═".repeat(width)}╝\n`);
}

/** Print a section divider (the "── Title ───" style). */
export function printSection(title: string): void {
	const dashes = "─".repeat(Math.max(2, 58 - title.length - 4));
	console.log(`\n── ${title} ${dashes}\n`);
}

// ── Structured output ───────────────────────────────────────────────

/**
 * Print a right-aligned key-value table.
 *
 * Aligns the colons by padding keys to the longest key length.
 * @example
 *   printKV([["App ID", "abc123"], ["Status", "complete"]]);
 *   //   App ID:   abc123
 *   //   Status:   complete
 */
export function printKV(entries: Array<[key: string, value: string]>): void {
	const maxKeyLen = entries.reduce((max, [k]) => Math.max(max, k.length), 0);
	for (const [key, value] of entries) {
		console.log(`  ${`${key}:`.padEnd(maxKeyLen + 2)}${value}`);
	}
}

/** Column definition for printTable. */
export interface TableColumn {
	header: string;
	/** "right" for numeric columns, "left" (default) for text. */
	align?: "left" | "right";
	/** Explicit minimum width. Auto-sized from content if omitted. */
	minWidth?: number;
}

/**
 * Print a columnar table with headers and auto-sized columns.
 *
 * Right-aligned columns are useful for numeric data. Columns auto-size
 * to fit the widest value (or header), with a 2-space gap between columns.
 *
 * @example
 *   printTable(
 *     [{ header: "Step", align: "right" }, { header: "Tools" }, { header: "Cost", align: "right" }],
 *     [["0", "generateSchema", "$0.0234"], ["1", "addModule", "$0.0567"]]
 *   );
 */
export function printTable(columns: TableColumn[], rows: string[][]): void {
	/* Compute column widths: max of header length, minimum width, and data. */
	const widths = columns.map((col, i) => {
		const dataMax = rows.reduce(
			(max, row) => Math.max(max, (row[i] ?? "").length),
			0,
		);
		return Math.max(col.header.length, col.minWidth ?? 0, dataMax);
	});

	/* Print header row. */
	const headerCells = columns.map((col, i) => {
		const w = widths[i];
		return col.align === "right"
			? col.header.padStart(w)
			: col.header.padEnd(w);
	});
	console.log(`  ${headerCells.join("  ")}`);

	/* Print separator row using ─ characters. */
	const separators = widths.map((w) => "─".repeat(w));
	console.log(`  ${separators.join("  ")}`);

	/* Print data rows. */
	for (const row of rows) {
		const cells = columns.map((col, i) => {
			const val = row[i] ?? "";
			const w = widths[i];
			return col.align === "right" ? val.padStart(w) : val.padEnd(w);
		});
		console.log(`  ${cells.join("  ")}`);
	}
}

// ── Comparison helpers ──────────────────────────────────────────────

/**
 * Format a numeric delta with sign prefix.
 * Positive values get "+", negative get "−" (Unicode minus), zero shows "0".
 */
export function formatDelta(
	a: number,
	b: number,
	formatter: (n: number) => string = String,
): string {
	const diff = b - a;
	if (diff === 0) return "0";
	const sign = diff > 0 ? "+" : "−";
	return `${sign}${formatter(Math.abs(diff))}`;
}

/**
 * Format a numeric delta for percentages.
 * Shows the absolute difference in percentage points with sign.
 */
export function formatPctDelta(a: number, b: number): string {
	const diff = b - a;
	if (Math.abs(diff) < 0.05) return "0";
	const sign = diff > 0 ? "+" : "−";
	return `${sign}${Math.abs(diff).toFixed(1)}%`;
}
