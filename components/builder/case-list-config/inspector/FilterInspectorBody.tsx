// components/builder/case-list-config/inspector/FilterInspectorBody.tsx
//
// Properties for Search's Cases available summary. The structural predicate
// editor lives here; the canvas keeps the always-on rule as one human-language
// summary row beneath the more common interactive search fields.
//
// The inspector header already says Search / Cases available, so the body
// carries no duplicate heading — one quiet hint line, then the condition
// editor directly on the rail background.
//
// A match count rides beneath the editor so authors get immediate scope
// feedback without turning edit mode into a one-record data preview.
// `loadFilterPreviewAction` returns the total matching count; its row sample
// is intentionally ignored here. The count renders as a plain sentence —
// useful feedback, not console state.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useEffect, useState } from "react";
import {
	InspectorHint,
	RemoveRow,
} from "@/components/builder/inspector/inspectorChrome";
import { comparisonDefault } from "@/components/builder/shared/cards/ComparisonCard";
import { PredicateCardEditor } from "@/components/builder/shared/PredicateCardEditor";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type { CaseListConfig, CaseType, CommitOutcome } from "@/lib/domain";
import {
	effectiveFilterForEmission,
	type Predicate,
} from "@/lib/domain/predicate";
import { loadFilterPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";

export interface FilterInspectorBodyProps {
	/** Full case-list config — the filter editor mutates the `filter`
	 *  slot; the match-count query uses its condition and property context. */
	readonly config: CaseListConfig;
	readonly onChange: (next: CaseListConfig) => void;
	/** Atomic filter-clear + automatic-search shutdown owned by the workspace. */
	readonly onClearFilter: (next: Predicate | undefined) => CommitOutcome;
	/** Clearing this final rule also removes the filter-only search marker. */
	readonly stopsAutomaticSearch: boolean;
	/** The shutdown intentionally discards settings that have no screen left. */
	readonly discardsAutomaticSearchSettings: boolean;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly appId: string;
}

export function FilterInspectorBody({
	config,
	onChange,
	onClearFilter,
	stopsAutomaticSearch,
	discardsAutomaticSearchSettings,
	caseTypes,
	currentCaseType,
	appId,
}: FilterInspectorBodyProps) {
	// Cached verdict from the editor — gates the match-count query so a
	// mid-edit condition that fails its type check doesn't reach the
	// case-store compiler. Reset to true on clear/add so a stale false
	// from a removed editor can't outlive it.
	const [filterValid, setFilterValid] = useState(true);
	const [pendingShutdown, setPendingShutdown] = useState<{
		readonly filter: Predicate | undefined;
	} | null>(null);

	const handleFilterChange = (next: Predicate | undefined) => {
		if (next === undefined) setFilterValid(true);
		// A filter-only automatic search needs a real narrowing predicate. The
		// structural editor can make the root ineffective too (for example by
		// choosing Always true or removing the final AND clause), so route that
		// transition through the same explicit shutdown as Show all cases. Keep
		// the proposed predicate pending until the author confirms; cancelling
		// leaves the current effective rule untouched.
		if (
			stopsAutomaticSearch &&
			effectiveFilterForEmission(next) === undefined
		) {
			setPendingShutdown({ filter: next });
			return;
		}
		onChange({ ...config, filter: next });
	};

	if (config.filter === undefined) {
		return (
			<>
				<InspectorHint>
					People can find only cases that pass this condition.
				</InspectorHint>
				<button
					type="button"
					onClick={() => {
						// A new rule starts as the common "Property is value"
						// sentence. Reuse the predicate editor's own default factory
						// so the first authorable property and its value are seeded
						// with matching data types; Always true remains available in
						// the verb menu when an author explicitly needs it.
						setFilterValid(true);
						handleFilterChange(
							comparisonDefault("eq", {
								caseTypes,
								currentCaseType,
								knownInputs: config.searchInputs,
							}),
						);
					}}
					className="w-full inline-flex items-center justify-center gap-2 px-3 min-h-11 text-[13px] rounded-lg border border-dashed border-white/[0.10] text-nova-text-muted hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				>
					<Icon icon={tablerPlus} width="14" height="14" />
					<span>Add a condition</span>
				</button>
			</>
		);
	}

	return (
		<>
			<InspectorHint>
				People can find only cases that pass this condition.
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
				label="Show all cases"
				onClick={() => {
					if (stopsAutomaticSearch) {
						setPendingShutdown({ filter: undefined });
						return;
					}
					handleFilterChange(undefined);
				}}
			/>
			<AlertDialog
				open={pendingShutdown !== null}
				onOpenChange={(open) => {
					if (!open) setPendingShutdown(null);
				}}
			>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							Show all cases instead?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This is the only rule behind automatic search. Showing every case
							turns automatic search off, so people will go straight to results.
							{discardsAutomaticSearchSettings
								? " Its automatic-search settings will be removed too."
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep this rule</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (pendingShutdown === null) return;
								setFilterValid(true);
								const outcome = onClearFilter(pendingShutdown.filter);
								if (outcome.ok) setPendingShutdown(null);
							}}
						>
							Show all cases
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

// ── Match count ───────────────────────────────────────────────────

type CountState =
	| { kind: "loading"; lastCount: number | null }
	| { kind: "count"; matching: number }
	| { kind: "unavailable" };

/**
 * Plain-language count with a small spinner while a recount settles. The last
 * settled count stays on screen during recounts so the line never flickers.
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
					// Every non-rows arm (no cases yet, schema syncing, auth)
					// degrades to "no count". The editor stays fully usable and
					// Search continues to show the authored summary or its
					// findable Needs attention state.
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
