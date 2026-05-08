// components/builder/case-list-config/FiltersPreview.tsx
//
// Live-preview panel for the Filters section. Surfaces TWO numbers
// simultaneously: how many cases pass the filter (`totalCount`) and
// what those cases look like (a top-N row sample). Re-runs the
// case-store query on every config / validity change.
//
// Shape mirrors the Display section's preview — same loading-
// state union, same Zod-rejected `invalid-config` /
// `invalid-blueprint` arms, same paused-state contract when the
// parent reports `filterValid: false`. The differences:
//
//   1. Uses `loadFilterPreviewAction` (rows + count vs rows alone).
//   2. Renders a count-card chrome above the row table with the
//      "N pass / M total" message.
//   3. Limits the row sample to `FILTER_PREVIEW_DEFAULT_LIMIT` (10
//      by default) — the filters preview is "what passes plus how
//      many", not the full list.
//
// Per-cell rendering routes through `./columnCellRenderer.tsx` —
// both previews share the same `renderColumnCell` /
// `renderCalculatedCell` implementations so a `date` column with
// pattern `short` renders identically across both surfaces. The
// two previews still own their own chrome (count card / sort
// indicator / empty-state copy) because those shapes are not
// identical between Display and Filters; the column-cell renderer
// is the natural seam.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerColumns from "@iconify-icons/tabler/columns";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerFilterCheck from "@iconify-icons/tabler/filter-check";
import tablerFilterOff from "@iconify-icons/tabler/filter-off";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerMathFunction from "@iconify-icons/tabler/math-function";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { CaseListConfig, Column } from "@/lib/domain";
import { loadFilterPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";
import type { LoadFilterPreviewResult } from "@/lib/preview/engine/caseDataBindingTypes";
import { renderColumnCell } from "./columnCellRenderer";

// ── Public types ──────────────────────────────────────────────────

export interface FilterPreviewStats {
	/** Cases passing the current filter — the same `totalCount` the
	 *  Server Action returns in the success arm. */
	readonly totalCount: number;
}

export interface FiltersPreviewProps {
	readonly appId: string;
	readonly caseListConfig: CaseListConfig;
	readonly currentCaseType: string;
	/**
	 * Whether the filter is currently in a valid AST state — the
	 * parent's aggregate validity verdict for the filter slot.
	 * When `false`, the preview suppresses the load and renders
	 * the paused state. An invalid predicate reaching
	 * `compilePredicate` would throw at the SQL layer; the
	 * filterValid gate is the structural defense.
	 */
	readonly filterValid: boolean;
	/**
	 * Live-preview stats callback. Fires with `{ totalCount }` once
	 * a successful preview load completes; fires with `null` while
	 * the preview is loading, paused, or in any error arm. Lets
	 * surfaces outside this preview (e.g. the workspace's filter
	 * section header) render the same live counts without
	 * duplicating the load.
	 */
	readonly onPreviewStats?: (stats: FilterPreviewStats | null) => void;
}

// ── Loading-state union ───────────────────────────────────────────

type PreviewState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "paused" }
	| LoadFilterPreviewResult;

// ── Top-level component ───────────────────────────────────────────

/**
 * Live-preview panel for the Filters section. Renders a count
 * card + a sampled-rows table. Loads on mount + on every config /
 * validity change; suppresses loads while the parent reports
 * `filterValid: false`.
 *
 * Shares the imperative-doc-projection pattern with
 * `DisplayPreview`: reads `BlueprintDoc` via
 * `useBlueprintDocApi().getState()` (non-subscribing) and projects
 * through `pickBlueprintDoc` so the wire shape survives RSC's
 * serializer.
 */
export function FiltersPreview({
	appId,
	caseListConfig,
	currentCaseType,
	filterValid,
	onPreviewStats,
}: FiltersPreviewProps) {
	const docApi = useBlueprintDocApi();
	const [state, setState] = useState<PreviewState>({ kind: "idle" });

	// Stash the latest `onPreviewStats` callback in a ref so the
	// load effect doesn't refire when the parent passes a fresh
	// closure each render. Same pattern the editor's validity
	// propagator uses for parent-callback identity drift.
	const onPreviewStatsRef = useRef(onPreviewStats);
	onPreviewStatsRef.current = onPreviewStats;
	// Publish the current state's stats slice every render. Fires
	// `null` for non-success arms (loading / paused / error / etc.)
	// and `{ totalCount }` for the rows arm. Consumers (e.g. the
	// workspace's filter section header) read the latest emitted
	// stats without needing to subscribe to the state union.
	useEffect(() => {
		const cb = onPreviewStatsRef.current;
		if (!cb) return;
		if (state.kind === "rows") {
			cb({ totalCount: state.totalCount });
		} else {
			cb(null);
		}
	}, [state]);

	// Visible columns — every column with `visibleInList ?? true`.
	// The schema treats absent slots as visible; only columns with
	// an explicit `visibleInList: false` are filtered out. Mirrors
	// the Display preview's filter so the two preview surfaces
	// agree on which columns the runtime case list will render.
	const visibleColumns = useMemo(
		() => caseListConfig.columns.filter((col) => col.visibleInList ?? true),
		[caseListConfig.columns],
	);

	// Trigger the action whenever the config / validity / case-type
	// changes. The `cancelled` flag handles the in-flight cancellation
	// case — a fresh effect fires before the previous resolved.
	useEffect(() => {
		if (!filterValid) {
			setState({ kind: "paused" });
			return;
		}
		let cancelled = false;
		setState({ kind: "loading" });
		const blueprint = pickBlueprintDoc(docApi.getState());
		loadFilterPreviewAction({
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
	}, [appId, caseListConfig, currentCaseType, filterValid, docApi.getState]);

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
		return (
			<PreviewMessage
				icon={tablerEye}
				tone="error"
				title="Case-list configuration is malformed"
				body={state.message}
			/>
		);
	}

	if (state.kind === "invalid-blueprint") {
		return (
			<PreviewMessage
				icon={tablerEye}
				tone="error"
				title="Blueprint is malformed"
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

	// `state.kind === "rows"` — the success arm. Carries the row
	// sample (possibly empty) plus the matching `totalCount`. The
	// count card surfaces above the table; if the row sample is
	// empty the body falls back to the empty-state message.
	const filterApplied = caseListConfig.filter !== undefined;
	const countCard = (
		<CountCard totalCount={state.totalCount} filterApplied={filterApplied} />
	);

	const rows = state.rows;
	if (rows.length === 0) {
		return (
			<div className="space-y-2">
				{countCard}
				<PreviewMessage
					icon={tablerEye}
					tone="muted"
					title={
						filterApplied ? "No cases pass this filter" : "No cases to preview"
					}
					body={
						filterApplied
							? "Adjust the filter, or generate sample data from the running-app view to populate this case list."
							: "Generate sample data from the running-app view to populate this case list."
					}
				/>
			</div>
		);
	}

	if (visibleColumns.length === 0) {
		return (
			<div className="space-y-2">
				{countCard}
				<PreviewMessage
					icon={tablerEye}
					tone="muted"
					title="No columns visible in the case list"
					body="Add a column or set an existing column's list visibility to render the row preview."
				/>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			{countCard}
			<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 overflow-hidden">
				<div className="overflow-x-auto">
					<table className="w-full text-[11px]">
						<thead>
							<tr className="bg-nova-surface/40">
								{visibleColumns.map((col) => (
									<th
										key={col.uuid}
										className="text-left px-3 py-2 font-medium text-nova-text border-b border-white/[0.06] whitespace-nowrap"
									>
										<HeaderLabel column={col} />
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
									{visibleColumns.map((col) => (
										<td
											key={col.uuid}
											className={`px-3 py-1.5 text-nova-text-secondary border-b border-white/[0.04] ${col.kind === "calculated" ? "font-mono" : ""}`}
										>
											{renderColumnCell(col, row)}
										</td>
									))}
								</motion.tr>
							))}
						</tbody>
					</table>
				</div>
				<div className="px-3 py-1.5 text-[10px] text-nova-text-muted/60 border-t border-white/[0.04] flex items-center justify-between gap-2">
					<span>
						Showing {rows.length} of {state.totalCount}{" "}
						{state.totalCount === 1 ? "row" : "rows"}.
					</span>
					{/* Truncation hint surfaces when the row sample is
					    smaller than the matching count. Communicates "the
					    sample is a slice; the full list is bigger" so
					    the author reads the sample size + total figure
					    together. */}
					{rows.length < state.totalCount ? (
						<span className="text-nova-text-muted/50">
							Top {rows.length} shown.
						</span>
					) : null}
				</div>
			</div>
		</div>
	);
}

// ── Count card ────────────────────────────────────────────────────

interface CountCardProps {
	readonly totalCount: number;
	readonly filterApplied: boolean;
}

/**
 * Renders the "N cases pass this filter" / "All M cases (no filter
 * applied)" header. The two messages differ in tone — the former
 * emphasizes the filter's discriminating role; the latter
 * communicates "no narrowing is happening yet" so the author knows
 * what state the live preview is in.
 *
 * Two icons distinguish the modes — `filterCheck` (filter applied,
 * cases passing) vs `filterOff` (no filter, every case visible).
 * The count number stays in violet bright-tone so the reader's eye
 * lands on the figure first.
 */
function CountCard({ totalCount, filterApplied }: CountCardProps) {
	const icon = filterApplied ? tablerFilterCheck : tablerFilterOff;
	const accent = filterApplied
		? "text-nova-violet-bright"
		: "text-nova-text-muted";
	return (
		<div className="rounded-md border border-white/[0.04] bg-nova-surface/30 px-3 py-2 flex items-center gap-2">
			<Icon icon={icon} width="14" height="14" className={accent} />
			<div className="flex items-baseline gap-1.5">
				{/* "All N cases" prefix on the no-filter copy reads as
				    "every case is visible"; the filter-applied copy
				    drops the prefix so "5 cases pass" reads as a
				    discrete count. The leading "All" cue is the
				    spec's chosen phrasing for the no-filter state. */}
				{!filterApplied && (
					<span className="text-[11px] text-nova-text-muted/80">All</span>
				)}
				<span className={`text-base font-semibold ${accent}`}>
					{totalCount}
				</span>
				<span className="text-[11px] text-nova-text-muted/80">
					{filterApplied
						? totalCount === 1
							? "case passes this filter"
							: "cases pass this filter"
						: totalCount === 1
							? "case (no filter applied)"
							: "cases (no filter applied)"}
				</span>
			</div>
		</div>
	);
}

// ── Header label ──────────────────────────────────────────────────

interface HeaderLabelProps {
	readonly column: Column;
}

/**
 * Column header label for the filter-preview row table. Symmetric
 * with `DisplayPreview`'s `HeaderLabel`, minus the sort indicator
 * — sort is a Display-section concern; the Filters preview reads
 * the row sample in the configured sort order but doesn't surface
 * the sort chrome itself (that lives in the Display section's
 * preview).
 *
 * The leading icon distinguishes calculated columns (math function
 * glyph) from the field-bearing kinds (text glyph) so the user
 * reads the column origin at-a-glance.
 */
function HeaderLabel({ column }: HeaderLabelProps) {
	const isCalc = column.kind === "calculated";
	const icon = isCalc ? tablerMathFunction : tablerColumns;
	const label = isCalc
		? column.header || "(unnamed)"
		: column.header || column.field || "(unnamed)";
	return (
		<span className="inline-flex items-center gap-1.5">
			<Icon
				icon={icon}
				width="11"
				height="11"
				className="text-nova-text-muted/60"
			/>
			<span>{label}</span>
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
 * Empty / paused / error message. Tone-driven palette mirrors
 * `DisplayPreview.PreviewMessage`. Three tones — `muted` for
 * neutral states, `warning` for authoring-side blocks, `error`
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
