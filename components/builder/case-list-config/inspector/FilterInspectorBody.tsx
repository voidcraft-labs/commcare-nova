// components/builder/case-list-config/inspector/FilterInspectorBody.tsx
//
// Properties for the case-list filter — what the canvas's filter
// affordance selects. The structural predicate editor lives here; the
// canvas shows the filter only as a human-language phrase and a live
// table that re-narrows as conditions change.
//
// A live match count rides beneath the editor (the canvas table shows
// the matching rows themselves, so the count card is the one piece of
// feedback that needs its own query — `loadFilterPreviewAction`
// returns the total matching count, not just the sampled rows).

"use client";
import { Icon } from "@iconify/react/offline";
import tablerCircleCheck from "@iconify-icons/tabler/circle-check";
import tablerFilter from "@iconify-icons/tabler/filter";
import { useEffect, useState } from "react";
import { PredicateSlotCard } from "@/components/builder/shared/PredicateSlotCard";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { CaseListConfig, CaseType } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { loadFilterPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";

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
	// Cached verdict from the slot card — gates the match-count query
	// so a mid-edit predicate that fails its type check doesn't reach
	// the case-store compiler.
	const [filterValid, setFilterValid] = useState(true);

	const handleFilterChange = (next: Predicate | undefined) => {
		onChange({ ...config, filter: next });
	};

	return (
		<>
			<PredicateSlotCard
				icon={tablerFilter}
				title="Filter"
				description="Always-on condition that narrows which cases appear in the list."
				addLabel="Add filter"
				clearLabel="Clear filter"
				value={config.filter}
				onChange={handleFilterChange}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				knownInputs={config.searchInputs}
				onValidityChange={setFilterValid}
			/>
			{config.filter !== undefined && (
				<MatchCount
					appId={appId}
					config={config}
					currentCaseType={currentCaseType}
					filterValid={filterValid}
				/>
			)}
		</>
	);
}

// ── Live match count ──────────────────────────────────────────────

type CountState =
	| { kind: "loading" }
	| { kind: "count"; matching: number }
	| { kind: "unavailable" };

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
	const [state, setState] = useState<CountState>({ kind: "loading" });

	useEffect(() => {
		if (!filterValid) {
			setState({ kind: "unavailable" });
			return;
		}
		let cancelled = false;
		setState({ kind: "loading" });
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

	return (
		<div className="flex items-center gap-2 px-3 py-2.5 rounded-md bg-nova-emerald/[0.08] border border-nova-emerald/20">
			<Icon
				icon={tablerCircleCheck}
				width="14"
				height="14"
				className="text-nova-emerald"
			/>
			<span className="text-xs text-nova-emerald">
				{state.kind === "loading"
					? "Counting matches…"
					: `${state.matching} ${state.matching === 1 ? "case matches" : "cases match"} — live`}
			</span>
		</div>
	);
}
