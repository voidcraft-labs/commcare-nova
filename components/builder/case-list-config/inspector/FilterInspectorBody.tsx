// components/builder/case-list-config/inspector/FilterInspectorBody.tsx
//
// Properties for the case-list filter — what the canvas's filter
// affordance selects. The structural predicate editor lives here; the
// canvas shows the filter only as a human-language phrase and a live
// table that re-narrows as conditions change.
//
// The inspector panel's own header already names this surface
// ("Filter"), so the body carries NO section header of its own — one
// quiet hint line, then the condition editor directly on the rail
// background. Boxing the editor again or re-titling it duplicates
// chrome the user just read.
//
// A live match count rides beneath the editor (the canvas table shows
// the matching rows themselves, so the count is the one piece of
// feedback that needs its own query — `loadFilterPreviewAction`
// returns the total matching count, not just the sampled rows). It
// renders as the same quiet LIVE console readout the canvas footer
// uses — a count is information, not a success state, so it never
// wears the semantic-green alert chrome.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useEffect, useState } from "react";
import { PredicateCardEditor } from "@/components/builder/shared/PredicateCardEditor";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { CaseListConfig, CaseType } from "@/lib/domain";
import { matchAll, type Predicate } from "@/lib/domain/predicate";
import { loadFilterPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";
import { InspectorHint, RemoveRow } from "./inspectorChrome";

export interface FilterInspectorBodyProps {
	/** Full case-list config — the filter editor mutates the `filter`
	 *  slot; the match-count query reads the whole config so sort /
	 *  calculated projections stay consistent with the canvas. */
	readonly config: CaseListConfig;
	readonly onChange: (next: CaseListConfig) => void;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly appId: string;
}

export function FilterInspectorBody({
	config,
	onChange,
	caseTypes,
	currentCaseType,
	appId,
}: FilterInspectorBodyProps) {
	// Cached verdict from the editor — gates the match-count query so a
	// mid-edit condition that fails its type check doesn't reach the
	// case-store compiler. Reset to true on clear/add so a stale false
	// from a removed editor can't outlive it.
	const [filterValid, setFilterValid] = useState(true);

	const handleFilterChange = (next: Predicate | undefined) => {
		if (next === undefined) setFilterValid(true);
		onChange({ ...config, filter: next });
	};

	if (config.filter === undefined) {
		return (
			<>
				<InspectorHint>
					Only cases that pass this condition show up in the list.
				</InspectorHint>
				<button
					type="button"
					onClick={() => {
						// matchAll() seeds without a false-error state — the verb
						// menu on the seeded row is the author's first real choice.
						setFilterValid(true);
						handleFilterChange(matchAll());
					}}
					className="w-full inline-flex items-center justify-center gap-2 px-3 min-h-11 text-[13px] rounded-lg border border-dashed border-white/[0.10] text-nova-text-muted hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					<span>Add a Filter</span>
				</button>
			</>
		);
	}

	return (
		<>
			<InspectorHint>
				Only cases that pass this condition show up in the list.
			</InspectorHint>
			<PredicateCardEditor
				value={config.filter}
				onChange={handleFilterChange}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				knownInputs={config.searchInputs}
				onValidityChange={setFilterValid}
			/>
			<MatchCount
				appId={appId}
				config={config}
				currentCaseType={currentCaseType}
				filterValid={filterValid}
			/>
			<RemoveRow
				label="Remove Filter"
				onClick={() => handleFilterChange(undefined)}
			/>
		</>
	);
}

// ── Live match count ──────────────────────────────────────────────

type CountState =
	| { kind: "loading"; lastCount: number | null }
	| { kind: "count"; matching: number }
	| { kind: "unavailable" };

/**
 * The same quiet console readout as the canvas footer — LIVE etched
 * eyebrow, the count in plain words, a small spinner while a recount
 * settles. The last settled count stays on screen during recounts so
 * the line never flickers back to a loading placeholder.
 */
function MatchCount({
	appId,
	config,
	currentCaseType,
	filterValid,
}: {
	readonly appId: string;
	readonly config: CaseListConfig;
	readonly currentCaseType: string;
	readonly filterValid: boolean;
}) {
	const docApi = useBlueprintDocApi();
	const [state, setState] = useState<CountState>({
		kind: "loading",
		lastCount: null,
	});

	useEffect(() => {
		if (!filterValid) {
			setState({ kind: "unavailable" });
			return;
		}
		let cancelled = false;
		setState((prev) => ({
			kind: "loading",
			lastCount: prev.kind === "count" ? prev.matching : null,
		}));
		const blueprint = pickBlueprintDoc(docApi.getState());
		loadFilterPreviewAction({
			appId,
			caseType: currentCaseType,
			blueprint,
			caseListConfig: config,
			limit: 1,
		})
			.then((result) => {
				if (cancelled) return;
				if (result.kind === "rows") {
					setState({ kind: "count", matching: result.totalCount });
				} else {
					// Every non-rows arm (no cases yet, schema syncing,
					// auth) degrades to "no count" — the editor stays
					// fully usable; the canvas table carries the
					// user-facing explanation for those states.
					setState({ kind: "unavailable" });
				}
			})
			.catch(() => {
				if (cancelled) return;
				setState({ kind: "unavailable" });
			});
		return () => {
			cancelled = true;
		};
	}, [appId, config, currentCaseType, filterValid, docApi.getState]);

	if (state.kind === "unavailable") return null;

	const settled =
		state.kind === "count"
			? state.matching
			: state.kind === "loading"
				? state.lastCount
				: null;

	return (
		<div className="flex items-center gap-2.5 text-xs text-nova-text-muted">
			<span className="font-mono text-[9px] tracking-[0.13em] text-nova-violet-bright/70">
				LIVE
			</span>
			<span>
				{settled === null
					? "Counting matches…"
					: `${settled} ${settled === 1 ? "case matches" : "cases match"}`}
			</span>
			{state.kind === "loading" && (
				<Icon
					icon={tablerLoader2}
					width="12"
					height="12"
					className="animate-spin"
					aria-label="Updating"
				/>
			)}
		</div>
	);
}
