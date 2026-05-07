// components/builder/case-list-config/DisplayPreview.tsx
//
// Live-preview panel for the case-list authoring surface. Reads the
// current `CaseListConfig` and renders a tabular view of how the
// case list would appear with sample data — same `cases` rows the
// running-app view would render, queried through the case-store's
// new `queryWithCalculated` method so calculated columns evaluate
// inline at the SQL layer.
//
// Authoring contract: the preview suppresses its load while the
// caller's `configValid` is `false`. Sending an invalid expression
// AST to `compileExpression` would throw at the SQL layer; the
// validity gate is the structural defense rather than a hint.
//
// Empty-state contract: per the task spec + advisor guidance, this
// is the AUTHORING surface — the preview does NOT expose the
// "Generate sample data" affordance (that lives at the running-app
// view's `CaseListScreen` per the no-preview-mode foundation lock
// at `feedback_no_preview_mode.md`). When no cases exist, the
// preview shows an instructional empty state pointing the author
// at the running-app view; populating sample data there reflects
// here on the next reload.
//
// Sort indicator: the preview renders sort arrows on column headers
// based on the authored `caseListConfig.sort` slot. The sort state
// is pure render-time derivation from props — clicking a column
// does NOT mutate the sort (the SortKeyEditor is the only sort
// mutator). Without this contract, a click-to-sort affordance would
// fork the sort state between the preview and the editor, and the
// editor's `valid: false` gate would lose its single source of
// truth.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerColumns from "@iconify-icons/tabler/columns";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerMathFunction from "@iconify-icons/tabler/math-function";
import tablerSortAscending from "@iconify-icons/tabler/sort-ascending";
import tablerSortDescending from "@iconify-icons/tabler/sort-descending";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { CaseListConfig, Column } from "@/lib/domain";
import { loadCaseListPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import {
	caseRowDisplayValue,
	pickBlueprintDoc,
} from "@/lib/preview/engine/caseDataBindingHelpers";
import type { LoadCaseListPreviewResult } from "@/lib/preview/engine/caseDataBindingTypes";
import { nodeId } from "./nodeIdentity";

// ── Public types ──────────────────────────────────────────────────

export interface DisplayPreviewProps {
	readonly appId: string;
	readonly caseListConfig: CaseListConfig;
	readonly currentCaseType: string;
	/** Aggregated validity verdict from the parent's sub-editors.
	 *  When `false`, the preview suppresses the load and renders
	 *  the "preview paused — fix errors above" state. */
	readonly configValid: boolean;
	/** Empty-state messaging override. Defaults to a hint pointing
	 *  the user at the running-app view's sample-data populate
	 *  affordance. */
	readonly emptyMessage?: string;
}

// ── Loading-state union ───────────────────────────────────────────

type PreviewState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "paused" }
	| LoadCaseListPreviewResult;

// ── Top-level component ───────────────────────────────────────────

/**
 * Live-preview table for the case-list authoring surface. Loads
 * rows on mount + on every config / validity change; suppresses
 * loads while the parent reports `configValid: false`.
 *
 * The Server Action call needs the `BlueprintDoc` for the case-
 * store's compiler stack to resolve property data types. The doc
 * is read imperatively via `useBlueprintDocApi().getState()` and
 * projected through `pickBlueprintDoc(...)` so the wire shape
 * survives RSC's serializer (action methods would reject at the
 * boundary). `getState()` doesn't subscribe — re-evaluation flows
 * through the deps-driven effect below.
 */
export function DisplayPreview({
	appId,
	caseListConfig,
	currentCaseType,
	configValid,
	emptyMessage,
}: DisplayPreviewProps) {
	const docApi = useBlueprintDocApi();

	// Reload key — increments when any of the props the preview
	// depends on changes. Pinning to a single counter (rather than
	// running effects per-prop) keeps the load cycle deterministic
	// and easy to reason about.
	const [state, setState] = useState<PreviewState>({ kind: "idle" });

	// Display columns only — `search-only` columns declare a property
	// as searchable without rendering a row. The preview filters them
	// out at the render layer (the underlying data still loads).
	const displayColumns = useMemo(
		() => caseListConfig.columns.filter((col) => col.kind !== "search-only"),
		[caseListConfig.columns],
	);

	// Sort indicator lookup — for each property column, find the
	// matching `SortKey` (if any) so the column header renders the
	// sort direction icon. Calculated-column sort indicators apply
	// to calculated-column header cells; the lookup keys differ
	// (property field vs calculated id) so the helper resolves both.
	const sortIndicatorByPropertyField = useMemo(() => {
		const map = new Map<string, "asc" | "desc">();
		for (const key of caseListConfig.sort) {
			if (key.source.kind === "property") {
				map.set(key.source.property, key.direction);
			}
		}
		return map;
	}, [caseListConfig.sort]);
	const sortIndicatorByCalculatedId = useMemo(() => {
		const map = new Map<string, "asc" | "desc">();
		for (const key of caseListConfig.sort) {
			if (key.source.kind === "calculated") {
				map.set(key.source.columnId, key.direction);
			}
		}
		return map;
	}, [caseListConfig.sort]);

	// Trigger the action whenever the config / validity / case-type
	// changes. The `cancelled` flag handles the in-flight cancellation
	// case — a fresh effect fires before the previous resolved.
	useEffect(() => {
		if (!configValid) {
			setState({ kind: "paused" });
			return;
		}
		let cancelled = false;
		setState({ kind: "loading" });
		// Project the doc once, at action-firing time. `getState()`
		// is non-subscribing; the effect already retriggers on every
		// dep change.
		const blueprint = pickBlueprintDoc(docApi.getState());
		loadCaseListPreviewAction({
			appId,
			caseType: currentCaseType,
			blueprint,
			caseListConfig,
		})
			.then((result) => {
				if (cancelled) return;
				setState(result);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setState({
					kind: "error",
					message:
						err instanceof Error ? err.message : "Failed to load preview.",
				});
			});
		return () => {
			cancelled = true;
		};
		// `docApi.getState` is a stable bound method on the doc-store
		// API singleton — Biome's exhaustive-deps linter expects it in
		// the dep list since the effect calls it. The identity doesn't
		// change across renders, so adding it to deps is a no-op for
		// re-firing while keeping the linter happy.
	}, [appId, caseListConfig, currentCaseType, configValid, docApi.getState]);

	// ── Render branches ──

	if (state.kind === "paused") {
		return (
			<PreviewMessage
				icon={tablerEye}
				tone="warning"
				title="Preview paused"
				body="Fix the errors above to see the live preview."
			/>
		);
	}

	if (state.kind === "idle" || state.kind === "loading") {
		return (
			<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 px-3 py-6 text-[11px] text-nova-text-muted/70">
				<div className="flex items-center justify-center gap-1.5">
					<Icon
						icon={tablerLoader2}
						width="14"
						height="14"
						className="animate-spin text-nova-text-muted/60"
					/>
					<span>Loading preview…</span>
				</div>
			</div>
		);
	}

	if (state.kind === "unauthenticated") {
		return (
			<PreviewMessage
				icon={tablerEye}
				tone="warning"
				title="Sign in to view the preview"
				body="The live preview reads case data from the live runtime, which requires an authenticated session."
			/>
		);
	}

	if (state.kind === "missing-case-type") {
		return (
			<PreviewMessage
				icon={tablerEye}
				tone="warning"
				title={`Case type "${state.caseType}" is no longer in the blueprint`}
				body="Refresh the page to re-resolve the schema and try again."
			/>
		);
	}

	if (state.kind === "schema-not-synced") {
		return (
			<PreviewMessage
				icon={tablerEye}
				tone="warning"
				title={`Case type "${state.caseType}" isn't ready yet`}
				body="The case-store is still syncing the schema. Try again in a moment."
			/>
		);
	}

	if (state.kind === "invalid-config") {
		// The wire-boundary parse rejected the config shape. The
		// editor's validity gate normally prevents this; reaching
		// here means a non-editor caller produced a config the Zod
		// schema rejects. Surface the parse-failure message so the
		// user (typically a developer hitting this from a fixture
		// or programmatic surface) sees the structural cause.
		return (
			<PreviewMessage
				icon={tablerEye}
				tone="error"
				title="Case-list configuration is malformed"
				body={state.message}
			/>
		);
	}

	if (state.kind === "error") {
		return (
			<PreviewMessage
				icon={tablerEye}
				tone="error"
				title="Couldn't load the preview"
				body={state.message}
			/>
		);
	}

	if (state.kind === "empty") {
		return (
			<PreviewMessage
				icon={tablerEye}
				tone="muted"
				title="No cases to preview"
				body={
					emptyMessage ??
					"Generate sample data from the running-app view to populate this case list."
				}
			/>
		);
	}

	// `state.kind === "rows"` — render the table.
	const rows = state.rows;
	const hasAnyColumns =
		displayColumns.length > 0 || caseListConfig.calculatedColumns.length > 0;

	if (!hasAnyColumns) {
		return (
			<PreviewMessage
				icon={tablerEye}
				tone="muted"
				title="No columns configured"
				body="Add a column or calculated column to render the preview."
			/>
		);
	}

	return (
		<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 overflow-hidden">
			<div className="overflow-x-auto">
				<table className="w-full text-[11px]">
					<thead>
						<tr className="bg-nova-surface/40">
							{/* Column / calculated-column React keys use
							    `nodeId(col)` — the same WeakMap-backed identity
							    helper every other case-list-config surface uses
							    for stable per-row keys. A `field:header` /
							    `id` composite would collide on degenerate
							    authoring shapes (two columns referencing the
							    same property + same header, two calculated
							    columns sharing an id mid-edit). The
							    `nodeId(...)` identity survives every authoring
							    transition the editor admits. */}
							{displayColumns.map((col) => (
								<th
									key={nodeId(col)}
									className="text-left px-3 py-2 font-medium text-nova-text border-b border-white/[0.06] whitespace-nowrap"
								>
									<HeaderLabel
										label={col.header || col.field || "(unnamed)"}
										icon={tablerColumns}
										sortDirection={sortIndicatorByPropertyField.get(col.field)}
									/>
								</th>
							))}
							{caseListConfig.calculatedColumns.map((col) => (
								<th
									key={nodeId(col)}
									className="text-left px-3 py-2 font-medium text-nova-text border-b border-white/[0.06] whitespace-nowrap"
								>
									<HeaderLabel
										label={col.header || col.id || "(unnamed)"}
										icon={tablerMathFunction}
										sortDirection={sortIndicatorByCalculatedId.get(col.id)}
									/>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rIdx) => (
							<motion.tr
								key={row.case_id}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								transition={{
									delay: Math.min(rIdx * 0.02, 0.4),
									duration: 0.18,
								}}
								className={`${
									rIdx % 2 === 0 ? "bg-transparent" : "bg-nova-surface/20"
								}`}
							>
								{displayColumns.map((col) => (
									<td
										key={nodeId(col)}
										className="px-3 py-1.5 text-nova-text-secondary border-b border-white/[0.04]"
									>
										{renderColumnCell(col, row)}
									</td>
								))}
								{caseListConfig.calculatedColumns.map((col) => (
									<td
										key={nodeId(col)}
										className="px-3 py-1.5 text-nova-text-secondary border-b border-white/[0.04] font-mono"
									>
										{renderCalculatedCell(row.calculated[col.id])}
									</td>
								))}
							</motion.tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="px-3 py-1.5 text-[10px] text-nova-text-muted/60 border-t border-white/[0.04]">
				Showing {rows.length} {rows.length === 1 ? "row" : "rows"}.
			</div>
		</div>
	);
}

// ── Column cell rendering ─────────────────────────────────────────
//
// Each column kind has its own render path. The runtime / wire-emit
// layers handle the same logic against the live engine; the preview
// reads off the already-loaded `CaseRow` and applies a best-effort
// formatter that mirrors the runtime's intent. Date / phone /
// id-mapping / late-flag formatting is intentionally simple here —
// the goal is "what does this look like", not "exact wire parity".
// The preview pins the column's authored shape; small format drift
// against CCHQ's runtime is acceptable for an authoring-time
// preview.

function renderColumnCell(
	column: Column,
	row: import("@/lib/case-store").CaseRow,
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
function renderCalculatedCell(
	value: import("@/lib/case-store").CalculatedValue | undefined,
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

// ── Header label ──────────────────────────────────────────────────

interface HeaderLabelProps {
	readonly label: string;
	readonly icon: React.ComponentProps<typeof Icon>["icon"];
	readonly sortDirection?: "asc" | "desc";
}

/**
 * Column header label. Renders the column's title plus a sort
 * indicator chip when the column is part of the authored sort.
 * The icon distinguishes plain columns (text) from calculated
 * columns (math function) so the user reads the column origin
 * at-a-glance.
 */
function HeaderLabel({ label, icon, sortDirection }: HeaderLabelProps) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<Icon
				icon={icon}
				width="11"
				height="11"
				className="text-nova-text-muted/60"
			/>
			<span>{label}</span>
			{sortDirection !== undefined && (
				<Icon
					aria-label={`Sorted ${sortDirection === "asc" ? "ascending" : "descending"}`}
					icon={
						sortDirection === "asc" ? tablerSortAscending : tablerSortDescending
					}
					width="11"
					height="11"
					className="text-nova-violet-bright/80"
				/>
			)}
		</span>
	);
}

// ── Preview message component ─────────────────────────────────────

interface PreviewMessageProps {
	readonly icon: React.ComponentProps<typeof Icon>["icon"];
	readonly tone: "muted" | "warning" | "error";
	readonly title: string;
	readonly body: string;
}

/**
 * Empty / paused / error message presented as a frosted-glass
 * surface. Three tones — `muted` for neutral states ("no cases"),
 * `warning` for authoring-side blocks ("preview paused"), `error`
 * for genuine failures.
 */
function PreviewMessage({ icon, tone, title, body }: PreviewMessageProps) {
	const toneCls =
		tone === "error"
			? "border-nova-error/35 bg-nova-error/5 text-nova-error/90"
			: tone === "warning"
				? "border-nova-warning/35 bg-nova-warning/5 text-nova-warning/90"
				: "border-white/[0.06] bg-nova-deep/30 text-nova-text-muted";
	const iconCls =
		tone === "error"
			? "text-nova-error/80"
			: tone === "warning"
				? "text-nova-warning/80"
				: "text-nova-text-muted/60";
	return (
		<div
			className={`rounded-md border px-3 py-3 text-[11px] flex items-start gap-2 ${toneCls}`}
		>
			<Icon
				icon={icon}
				width="14"
				height="14"
				className={`mt-0.5 ${iconCls}`}
			/>
			<div className="space-y-0.5">
				<div className="font-medium text-nova-text/90">{title}</div>
				<div className="text-nova-text-muted/80 whitespace-pre-line">
					{body}
				</div>
			</div>
		</div>
	);
}
