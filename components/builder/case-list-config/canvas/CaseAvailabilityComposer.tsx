// components/builder/case-list-config/canvas/CaseAvailabilityComposer.tsx
//
// Results' direct-composition surface for deciding which cases may appear.
// The domain's complete recursive Predicate AST is authored through the
// focus-and-context workbench: no root projection, flattening, or second model.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerFilter from "@iconify-icons/tabler/filter";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	AddConditionMenu,
	PredicateWorkbench,
} from "@/components/builder/shared/PredicateWorkbench";
import type { EditorPath } from "@/components/builder/shared/path";
import type { EditorSearchInputDecl } from "@/components/builder/shared/searchInputPresentation";
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
import { Button } from "@/components/shadcn/button";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import type {
	CaseListConfig,
	CaseSearchConfig,
	CaseType,
	CommitOutcome,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	type Predicate,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { loadFilterPreviewAction } from "@/lib/preview/engine/caseDataBinding";
import { pickBlueprintDoc } from "@/lib/preview/engine/caseDataBindingClient";
import { useCaseDataRevision } from "@/lib/preview/hooks/caseDataInvalidation";
import { useCanEdit } from "@/lib/session/hooks";
import { summarizeFilter } from "../predicateSummary";
import { searchInputDecls } from "../searchInputResolution";
import {
	AssignedCasesSetting,
	assignedCasesMode,
} from "./AssignedCasesSetting";

export interface CaseAvailabilityComposerProps {
	readonly config: CaseListConfig;
	readonly filterBroken: boolean;
	readonly excludedOwnerIdsBroken?: boolean;
	/** Granular `setCaseListMeta` edit owned by the workspace. */
	readonly onFilterChange: (next: Predicate | undefined) => CommitOutcome;
	/** Clears only the authored availability predicate. */
	readonly onClearFilter: (next: Predicate | undefined) => CommitOutcome;
	/** Search-side state that also carries the one assigned-case rule. */
	readonly searchConfig: CaseSearchConfig | undefined;
	/** Whether this module has an effective Search action. The raw config can be
	 * present solely to store assigned-case availability, so it cannot answer
	 * this question by itself. */
	readonly caseSearchEnabled: boolean;
	readonly onExcludedOwnerIdsChange: (
		next: ValueExpression | undefined,
	) => void;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly appId: string;
	readonly dependencyReview?:
		| {
				readonly kind: "cases-available";
				readonly token: number;
				readonly path: EditorPath;
				readonly inputLabel: string;
		  }
		| {
				readonly kind: "assigned-cases";
				readonly token: number;
				readonly inputLabel: string;
		  };
	readonly onReturnToSearchField?: () => void;
}

export function CaseAvailabilityComposer({
	config,
	filterBroken,
	excludedOwnerIdsBroken = false,
	onFilterChange,
	onClearFilter,
	searchConfig,
	caseSearchEnabled,
	onExcludedOwnerIdsChange,
	caseTypes,
	currentCaseType,
	appId,
	dependencyReview,
	onReturnToSearchField,
}: CaseAvailabilityComposerProps) {
	const canEdit = useCanEdit();
	const [pendingShutdown, setPendingShutdown] = useState(false);
	const addConditionRegionRef = useRef<HTMLDivElement>(null);
	const focusAddConditionAfterClearRef = useRef(false);

	useEffect(() => {
		if (
			!focusAddConditionAfterClearRef.current ||
			config.filter !== undefined
		) {
			return;
		}
		const frame = requestAnimationFrame(() => {
			addConditionRegionRef.current
				?.querySelector<HTMLButtonElement>("button")
				?.focus();
			focusAddConditionAfterClearRef.current = false;
		});
		return () => cancelAnimationFrame(frame);
	}, [config.filter]);

	const proposeFilter = (next: Predicate | undefined) => {
		if (
			config.filter !== undefined &&
			effectiveFilterForEmission(next) === undefined
		) {
			setPendingShutdown(true);
			return;
		}
		onFilterChange(next);
	};

	const inputDecls = useMemo(
		() => searchInputDecls(config.searchInputs),
		[config.searchInputs],
	);
	const editContext = {
		caseTypes,
		currentCaseType,
		knownInputs: inputDecls,
	};
	const ownerMode = assignedCasesMode(searchConfig?.excludedOwnerIds);
	const hasAssignedCaseRule = ownerMode !== "all";

	return (
		<>
			{dependencyReview !== undefined ? (
				<div
					data-dependency-review-navigation
					className="mb-3 flex flex-col gap-3 rounded-xl border border-nova-violet/20 bg-nova-violet/[0.05] p-3 @sm:flex-row @sm:items-center @sm:justify-between"
				>
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						<strong className="font-semibold text-nova-text">
							{dependencyReview.inputLabel}
						</strong>{" "}
						is used in{" "}
						{dependencyReview.kind === "assigned-cases"
							? "Assigned cases"
							: "Cases available"}
					</p>
					<Button
						type="button"
						variant="outline"
						size="xl"
						onClick={onReturnToSearchField}
						aria-label={`Back to ${dependencyReview.inputLabel} search field`}
						className="shrink-0 border-white/[0.09] px-4 text-[14px]"
					>
						Back to field
					</Button>
				</div>
			) : null}
			<section
				data-case-availability-composer
				aria-label="Case availability"
				tabIndex={-1}
				className={`overflow-hidden rounded-2xl border bg-nova-surface/20 outline-none focus-visible:ring-2 focus-visible:ring-nova-violet/65 focus-visible:ring-offset-2 focus-visible:ring-offset-nova-deep ${
					filterBroken || excludedOwnerIdsBroken
						? "border-nova-rose/35"
						: "border-white/[0.08]"
				}`}
			>
				{config.filter === undefined ? (
					<div className="flex min-h-24 items-center gap-3 px-4 py-4">
						<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-nova-text-secondary">
							<Icon icon={tablerFilter} width="17" height="17" />
						</span>
						<div className="min-w-0 flex-1">
							<p className="text-[14px] font-semibold text-nova-text">
								{hasAssignedCaseRule
									? "The assigned cases setting limits which cases appear"
									: "All cases are available"}
							</p>
							<p className="mt-1 text-[13px] leading-relaxed text-nova-text-muted">
								{hasAssignedCaseRule
									? ownerMode === "current-user"
										? "Cases assigned to the person using the app are hidden from Results"
										: "Your saved setting decides which assigned cases can appear in Results"
									: canEdit
										? "Add a condition only when Results should show a smaller set"
										: "Results can include every available case"}
							</p>
						</div>
					</div>
				) : canEdit ? (
					<div className="p-3 @sm:p-4">
						{filterBroken && (
							<div className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-nova-rose">
								<Icon icon={tablerAlertCircle} width="14" height="14" />
								Some conditions need attention
							</div>
						)}
						<PredicateWorkbench
							value={config.filter}
							onChange={proposeFilter}
							onRemoveRoot={() => proposeFilter(undefined)}
							removeRootLabel={
								hasAssignedCaseRule
									? "Remove these conditions"
									: "Show all cases"
							}
							caseTypes={caseTypes}
							currentCaseType={currentCaseType}
							knownInputs={inputDecls}
							evaluationTarget={caseSearchEnabled ? "case-search" : "on-device"}
							focusRequest={
								dependencyReview?.kind === "cases-available"
									? dependencyReview
									: undefined
							}
						/>
					</div>
				) : (
					<div className="p-3 @sm:p-4">
						{filterBroken && (
							<div className="mb-3 flex items-start gap-2 rounded-xl border border-nova-rose/30 bg-nova-rose/[0.04] px-3 py-2.5 text-[13px] leading-relaxed text-nova-rose">
								<Icon
									icon={tablerAlertCircle}
									width="15"
									height="15"
									className="mt-0.5 shrink-0"
								/>
								<p>
									Results may not show the intended cases because this rule
									needs attention. Ask someone who can edit the app to fix it.
								</p>
							</div>
						)}
						<ReadOnlyCondition
							value={config.filter}
							caseTypes={caseTypes}
							currentCaseType={currentCaseType}
							knownInputs={inputDecls}
						/>
					</div>
				)}

				{canEdit && config.filter === undefined && (
					<div
						ref={addConditionRegionRef}
						className="border-t border-white/[0.07] p-3"
					>
						<AddConditionMenu
							ctx={editContext}
							onAdd={(next) => proposeFilter(next)}
							className="w-full"
						/>
					</div>
				)}

				<div className="border-t border-white/[0.07]">
					<AssignedCasesSetting
						value={searchConfig?.excludedOwnerIds}
						onChange={onExcludedOwnerIdsChange}
						canEdit={canEdit}
						hasError={excludedOwnerIdsBroken}
						reviewRequest={
							dependencyReview?.kind === "assigned-cases"
								? dependencyReview
								: undefined
						}
					/>
				</div>

				{(config.filter !== undefined || hasAssignedCaseRule) && (
					<MatchCount
						appId={appId}
						config={config}
						currentCaseType={currentCaseType}
						filterValid={!filterBroken && !excludedOwnerIdsBroken}
						excludedOwnerIdsExpression={searchConfig?.excludedOwnerIds}
					/>
				)}
			</section>

			<AlertDialog
				open={pendingShutdown}
				onOpenChange={(open) => {
					if (!open) setPendingShutdown(false);
				}}
			>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							Cases excluded by these conditions can appear in Results
						</AlertDialogTitle>
						<AlertDialogDescription>
							These availability conditions will be removed
							{hasAssignedCaseRule
								? ". The assigned cases setting doesn’t change."
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (!pendingShutdown) return;
								const outcome = onClearFilter(undefined);
								if (outcome.ok) {
									focusAddConditionAfterClearRef.current = true;
									setPendingShutdown(false);
								}
							}}
						>
							Remove conditions
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function ReadOnlyCondition({
	value,
	caseTypes,
	currentCaseType,
	knownInputs,
}: {
	readonly value: Predicate;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly EditorSearchInputDecl[];
}) {
	const summary = summarizeFilter(value, {
		caseTypes,
		currentCaseType,
		knownInputs,
	});
	return (
		<div className="rounded-xl border border-white/[0.07] bg-nova-deep/30 px-4 py-3">
			<p className="text-[14px] leading-relaxed text-nova-text-secondary first-letter:uppercase">
				{summary ?? "All cases"}
			</p>
		</div>
	);
}

type CountState =
	| { kind: "loading"; lastCount: number | null }
	| { kind: "count"; matching: number }
	| { kind: "invalid" }
	| { kind: "unavailable" };

/** Quiet aggregate feedback over the complete composed predicate. */
function MatchCount({
	appId,
	config,
	currentCaseType,
	filterValid,
	excludedOwnerIdsExpression,
}: {
	readonly appId: string;
	readonly config: CaseListConfig;
	readonly currentCaseType: string;
	readonly filterValid: boolean;
	readonly excludedOwnerIdsExpression: ValueExpression | undefined;
}) {
	const docApi = useBlueprintDocApi();
	const caseDataRevision = useCaseDataRevision(appId, currentCaseType);
	const [state, setState] = useState<CountState>({
		kind: "loading",
		lastCount: null,
	});
	const [retryKey, setRetryKey] = useState(0);
	const statusRef = useRef<HTMLDivElement>(null);
	const retryButtonRef = useRef<HTMLButtonElement>(null);
	const retryFocusPhaseRef = useRef<"idle" | "requested" | "loading">("idle");

	useEffect(() => {
		// These values exist only to request another load: retryKey after an
		// unavailable response, and caseDataRevision after a create/replace/update.
		// Reading them here makes that scheduling role explicit.
		void retryKey;
		void caseDataRevision;
		if (!filterValid) {
			setState({ kind: "invalid" });
			return;
		}
		let cancelled = false;
		setState((previous) => ({
			kind: "loading",
			lastCount: previous.kind === "count" ? previous.matching : null,
		}));
		const blueprint = pickBlueprintDoc(docApi.getState());
		loadFilterPreviewAction({
			appId,
			caseType: currentCaseType,
			blueprint,
			caseListConfig: config,
			excludedOwnerIdsExpression,
			limit: 1,
		})
			.then((result) => {
				if (cancelled) return;
				setState(
					result.kind === "rows"
						? { kind: "count", matching: result.totalCount }
						: { kind: "unavailable" },
				);
			})
			.catch(() => {
				if (!cancelled) setState({ kind: "unavailable" });
			});
		return () => {
			cancelled = true;
		};
	}, [
		appId,
		caseDataRevision,
		config,
		currentCaseType,
		excludedOwnerIdsExpression,
		filterValid,
		retryKey,
		docApi.getState,
	]);

	useEffect(() => {
		if (
			state.kind === "unavailable" &&
			retryFocusPhaseRef.current === "loading"
		) {
			retryButtonRef.current?.focus({ preventScroll: true });
			retryFocusPhaseRef.current = "idle";
		} else if (state.kind === "count" || state.kind === "invalid") {
			retryFocusPhaseRef.current = "idle";
		}
	}, [state.kind]);
	useLayoutEffect(() => {
		if (retryFocusPhaseRef.current !== "idle" && state.kind === "loading") {
			statusRef.current?.focus({ preventScroll: true });
			retryFocusPhaseRef.current = "loading";
		}
	}, [state.kind]);

	if (state.kind === "invalid") return null;
	const unavailable = state.kind === "unavailable";
	const settled =
		state.kind === "count"
			? state.matching
			: state.kind === "loading"
				? state.lastCount
				: null;

	/* One persistent status element spans unavailable → loading → settled.
	 * Retry can therefore move focus to a target that survives the state
	 * transition instead of letting the removed button strand focus on body. */
	return (
		<div
			ref={statusRef}
			role="status"
			aria-live="polite"
			aria-atomic="true"
			aria-busy={state.kind === "loading"}
			tabIndex={-1}
			className={
				unavailable
					? "flex min-h-14 flex-wrap items-center gap-2 border-t border-white/[0.07] px-4 py-2.5"
					: "flex items-center gap-2.5 border-t border-white/[0.07] px-4 py-3 text-[13px] text-nova-text-muted"
			}
		>
			{unavailable ? (
				<>
					<p className="min-w-0 flex-1 text-[13px] leading-relaxed text-nova-text-muted">
						The number of matching cases isn’t available
					</p>
					<Button
						ref={retryButtonRef}
						type="button"
						variant="ghost"
						size="xl"
						onClick={() => {
							retryFocusPhaseRef.current = "requested";
							// The status container survives unavailable -> loading. Move
							// focus before scheduling the retry so a busy render cannot
							// briefly strand keyboard focus on the button being removed.
							statusRef.current?.focus({ preventScroll: true });
							setRetryKey((current) => current + 1);
						}}
						className="shrink-0 px-3 text-[14px] text-nova-violet-bright not-disabled:hover:bg-nova-violet/[0.08] dark:not-disabled:hover:bg-nova-violet/[0.08]"
					>
						Try again
					</Button>
				</>
			) : (
				<>
					<span>
						{settled === null
							? "Counting matches…"
							: `${settled.toLocaleString()} ${settled === 1 ? "case matches" : "cases match"}`}
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
				</>
			)}
		</div>
	);
}
