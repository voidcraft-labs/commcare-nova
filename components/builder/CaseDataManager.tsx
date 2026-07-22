/**
 * Builder-owned case-data controls. This lives in the breadcrumb strip rather
 * than inside the simulated app: Preview stays faithful to what a frontline
 * user sees, while the builder keeps one predictable place to create or
 * replace the real case rows used for testing.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerArchive from "@iconify-icons/tabler/archive";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import { useCallback, useEffect, useRef, useState } from "react";
import { heldCaseCount } from "@/components/builder/data-review/dataReviewModel";
import { NameChip } from "@/components/builder/data-review/NameChip";
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
import {
	Popover,
	PopoverClose,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { useProjectToast } from "@/lib/collab/useProjectToast";
import type { Uuid } from "@/lib/doc/types";
import { type CaseType, humanizeId } from "@/lib/domain";
import type { PopulateSampleCasesResult } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	useCaseCount,
	useParkedValues,
	usePopulateSampleCases,
	useResetSampleCases,
} from "@/lib/preview/hooks/useCaseDataBinding";
import { useNavigate } from "@/lib/routing/hooks";
import {
	useAccessPhase,
	useProjectScopeEpoch,
	useSetPreviewing,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";

type Operation = "create" | "replace" | null;

/** Sample generation can fail with detailed case-store or schema diagnostics.
 * Those details remain in server observability; this builder surface explains
 * the consequence and next action without exposing implementation language. */
function sampleCaseError(
	result: Exclude<PopulateSampleCasesResult, { kind: "ok" }>,
	operation: Exclude<Operation, null>,
): string {
	if (result.kind === "unauthenticated") {
		return "You're signed out. Reload the page to sign in again, then try again.";
	}
	if (result.kind === "missing-case-type") {
		return "These cases are no longer part of the app. Refresh the page, then try again.";
	}
	if (result.kind === "schema-not-synced") {
		return "Case data isn't ready yet. Wait a moment, then try again.";
	}
	if (result.kind === "validation-failure") {
		return operation === "replace"
			? "Your current cases weren't changed. Check the case fields, then try replacing the case data again."
			: "Sample cases weren't added. Check the case fields, then try again.";
	}
	return operation === "replace"
		? "Your current cases weren't changed. Nova couldn't replace the case data. Try again."
		: "Nova couldn't add sample cases. Try again.";
}

function caseLabel(count: number): string {
	return `${count.toLocaleString()} ${count === 1 ? "case" : "cases"}`;
}

export function CaseDataManager({
	appId,
	moduleUuid,
	caseType,
	canEdit,
	hasLinkedChildren,
}: {
	readonly appId: string;
	readonly moduleUuid: Uuid;
	readonly caseType: CaseType;
	readonly canEdit: boolean;
	readonly hasLinkedChildren: boolean;
}) {
	const accessPhase = useAccessPhase();
	const scopeEpoch = useProjectScopeEpoch();
	const projectToast = useProjectToast();
	const session = useBuilderSessionApi();
	const {
		state: countState,
		fetching,
		reload: reloadCount,
	} = useCaseCount({
		includeHeld: true,
		appId,
		caseType: caseType.name,
	});
	/* The review discovery signals: the amber dot on the trigger (what
	 * remains after the conversion toast dies) and the popover's review
	 * section. Both derive from the same list the review screen renders,
	 * so one invalidation refreshes every surface. At zero active
	 * entries neither renders — no empty-state noise. */
	const { state: parkedState } = useParkedValues({
		appId,
		caseType: caseType.name,
	});
	const activeParked =
		parkedState.kind === "entries"
			? parkedState.entries.filter((entry) => entry.dismissedAt === null)
			: [];
	const heldCases = heldCaseCount(
		parkedState.kind === "entries" ? parkedState.entries : [],
	);
	const navigate = useNavigate();
	const setPreviewing = useSetPreviewing();
	const populate = usePopulateSampleCases({ appId, caseType });
	const reset = useResetSampleCases({ appId, caseType });
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [operation, setOperation] = useState<Operation>(null);
	const [error, setError] = useState<string | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popoverTitleRef = useRef<HTMLHeadingElement>(null);
	const confirmTitleRef = useRef<HTMLHeadingElement>(null);
	const pendingFocusFrameRef = useRef<number | null>(null);
	const cancelPendingFocusFrame = useCallback(() => {
		if (pendingFocusFrameRef.current === null) return;
		cancelAnimationFrame(pendingFocusFrameRef.current);
		pendingFocusFrameRef.current = null;
	}, []);
	const localScopeEpochRef = useRef(scopeEpoch);
	useEffect(() => {
		if (localScopeEpochRef.current === scopeEpoch) return;
		localScopeEpochRef.current = scopeEpoch;
		cancelPendingFocusFrame();
		setPopoverOpen(false);
		setConfirmOpen(false);
		setOperation(null);
		setError(null);
	}, [cancelPendingFocusFrame, scopeEpoch]);
	const refocusPendingSurface = useCallback(
		(target: HTMLElement | null) => {
			cancelPendingFocusFrame();
			target?.focus();
			pendingFocusFrameRef.current = requestAnimationFrame(() => {
				pendingFocusFrameRef.current = null;
				target?.focus();
			});
		},
		[cancelPendingFocusFrame],
	);
	const registerPendingFocus = useCallback(
		(surface: HTMLElement, title: HTMLElement | null) => {
			// Base UI resolves its focus target after the pending state disables the
			// pressed action. The callback ref runs with that DOM committed, so focus
			// lands on the explanation instead of the popup or a focus guard.
			refocusPendingSurface(title);
			const keepPendingFocusInside = (event: PointerEvent) => {
				if (surface.contains(event.target as Node)) return;
				// A pointer sequence can blur after Base UI has issued and Nova has
				// cancelled its close request. Recover after that sequence completes.
				refocusPendingSurface(title);
			};
			document.addEventListener("pointerdown", keepPendingFocusInside, true);
			return () => {
				document.removeEventListener(
					"pointerdown",
					keepPendingFocusInside,
					true,
				);
				cancelPendingFocusFrame();
			};
		},
		[cancelPendingFocusFrame, refocusPendingSurface],
	);
	const pendingPopoverContentRef = useCallback(
		(surface: HTMLDivElement | null) => {
			if (surface === null || operation !== "create") return;
			return registerPendingFocus(surface, popoverTitleRef.current);
		},
		[operation, registerPendingFocus],
	);
	const pendingConfirmContentRef = useCallback(
		(surface: HTMLDivElement | null) => {
			if (surface === null || operation !== "replace") return;
			return registerPendingFocus(surface, confirmTitleRef.current);
		},
		[operation, registerPendingFocus],
	);
	const restoreTriggerFocus = () => {
		requestAnimationFrame(() => triggerRef.current?.focus());
	};
	const retryCount = async () => {
		const pending = reloadCount();
		requestAnimationFrame(() => popoverTitleRef.current?.focus());
		await pending;
		requestAnimationFrame(() => popoverTitleRef.current?.focus());
	};

	const count = countState.kind === "count" ? countState.count : undefined;
	const caseTypeDisplayName = humanizeId(caseType.name) || "Case";
	const triggerSummary =
		count !== undefined
			? caseLabel(count)
			: countState.kind === "error" || countState.kind === "unauthenticated"
				? "Unavailable"
				: "Loading…";
	const triggerCountStatus =
		count !== undefined
			? `${caseLabel(count)}${fetching ? ", refreshing" : ""}`
			: countState.kind === "error" || countState.kind === "unauthenticated"
				? "Case count unavailable"
				: "Case count loading";
	const triggerLabel = `Case data for ${caseTypeDisplayName}. ${triggerCountStatus}.${
		heldCases > 0
			? ` ${heldCases === 1 ? "1 case" : `${heldCases} cases`} held for review.`
			: ""
	} Case data is shared throughout your app`;

	const createSamples = async () => {
		const start = session.getState();
		if (start.accessPhase !== "authorized" || !start.canEdit) return;
		const operationEpoch = start.scopeEpoch;
		const isCurrent = () => {
			const current = session.getState();
			return (
				current.scopeEpoch === operationEpoch &&
				current.accessPhase === "authorized" &&
				current.canEdit
			);
		};
		setOperation("create");
		setError(null);
		try {
			const result = await populate();
			if (!isCurrent()) return;
			if (result.kind !== "ok") {
				setError(sampleCaseError(result, "create"));
				return;
			}
			setPopoverOpen(false);
			projectToast(
				"info",
				"Sample cases created",
				`${caseLabel(result.inserted)} ${result.inserted === 1 ? "is" : "are"} ready to use in Preview`,
			);
		} catch {
			if (!isCurrent()) return;
			setError("Nova couldn't add sample cases. Try again.");
		} finally {
			if (isCurrent()) setOperation(null);
		}
	};

	const replaceSamples = async () => {
		const start = session.getState();
		if (start.accessPhase !== "authorized" || !start.canEdit) return;
		const operationEpoch = start.scopeEpoch;
		const isCurrent = () => {
			const current = session.getState();
			return (
				current.scopeEpoch === operationEpoch &&
				current.accessPhase === "authorized" &&
				current.canEdit
			);
		};
		setOperation("replace");
		setError(null);
		try {
			const result = await reset();
			if (!isCurrent()) return;
			if (result.kind !== "ok") {
				setError(sampleCaseError(result, "replace"));
				return;
			}
			setConfirmOpen(false);
			restoreTriggerFocus();
			projectToast(
				"info",
				"Case data replaced",
				`${caseLabel(result.inserted)} ${result.inserted === 1 ? "is" : "are"} ready to use in Preview`,
			);
		} catch {
			if (!isCurrent()) return;
			setError(
				"Your current cases weren't changed. Nova couldn't replace the case data. Try again.",
			);
		} finally {
			if (isCurrent()) setOperation(null);
		}
	};

	const loading = operation !== null;

	return (
		<>
			<Popover
				open={popoverOpen && accessPhase === "authorized"}
				modal={operation === "create" ? "trap-focus" : false}
				onOpenChange={(nextOpen, eventDetails) => {
					if (accessPhase !== "authorized") {
						setPopoverOpen(false);
						return;
					}
					// The write continues once it starts. Keep its progress and any
					// failure feedback perceivable instead of letting Escape, an outside
					// press, or a second trigger press dismiss the only status surface.
					if (!nextOpen && loading) {
						eventDetails.cancel();
						refocusPendingSurface(popoverTitleRef.current);
						return;
					}
					setPopoverOpen(nextOpen);
				}}
			>
				<PopoverTrigger
					ref={triggerRef}
					render={<Button type="button" variant="outline" size="xl" />}
					aria-label={triggerLabel}
					className="relative min-h-11 shrink-0 gap-2 rounded-lg border-nova-border bg-nova-surface/70 px-2.5 text-sm text-nova-text-secondary not-disabled:hover:border-nova-violet/45 not-disabled:hover:bg-nova-elevated not-disabled:hover:text-nova-text xl:px-3"
				>
					<Icon icon={tablerDatabase} width="16" height="16" />
					<span className="inline-flex items-center gap-2">
						<span>Case data</span>
						<span
							className="hidden text-nova-text-muted sm:inline"
							aria-hidden="true"
						>
							·
						</span>
					</span>
					<span className="hidden text-nova-text sm:inline">
						{triggerSummary}
					</span>
					{fetching && count !== undefined && (
						<Icon
							icon={tablerLoader2}
							width="14"
							height="14"
							className="animate-spin text-nova-text-muted"
							aria-label="Refreshing case count…"
						/>
					)}
					{/* The durable discovery signal — outlives the conversion
					 * toast, clears when no undismissed entries remain. Amber:
					 * the warning hue, never rose (nothing failed; values are
					 * waiting). */}
					{activeParked.length > 0 && (
						<span
							aria-hidden="true"
							className="absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-pv-bg bg-nova-amber"
						/>
					)}
				</PopoverTrigger>
				<PopoverContent
					ref={pendingPopoverContentRef}
					align="end"
					sideOffset={8}
					initialFocus={popoverTitleRef}
					className="max-h-[calc(var(--available-height)-0.5rem)] w-80 max-w-[calc(var(--available-width)-0.5rem)] gap-0 overflow-x-hidden overflow-y-auto p-0"
				>
					{/* Base UI enables modal Popover focus containment only when a Close
					 * part is registered. The write cannot be cancelled, so this technical
					 * close part stays hidden and unavailable while the pending title is
					 * the one honest keyboard stop. */}
					{operation === "create" && (
						<PopoverClose
							disabled
							aria-hidden="true"
							tabIndex={-1}
							className="sr-only"
						>
							Close case data
						</PopoverClose>
					)}
					<PopoverHeader className="gap-1.5 px-4 pb-4 pt-4">
						<PopoverTitle
							ref={popoverTitleRef}
							tabIndex={operation === "create" ? 0 : -1}
							className="font-display text-base font-semibold text-nova-text outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-nova-violet-bright/75 focus-visible:ring-offset-2 focus-visible:ring-offset-nova-deep"
						>
							Case data
						</PopoverTitle>
						<PopoverDescription className="text-sm leading-relaxed text-nova-text-secondary">
							{canEdit ? "Add or replace" : "View"} the cases saved for the{" "}
							<NameChip label={caseType.name} /> case type. They’re used
							throughout your app and in Preview.
						</PopoverDescription>
					</PopoverHeader>
					{operation === "create" && (
						<p
							role="status"
							aria-live="polite"
							aria-atomic="true"
							className="sr-only"
						>
							Adding sample cases…
						</p>
					)}

					{/* Review section — news first, between the header and the
					 * count block, so the popover's existing jobs stay
					 * untouched. Renders only while undismissed entries exist. */}
					{activeParked.length > 0 && (
						<div className="mx-4 mb-4 rounded-lg border border-nova-amber/30 bg-nova-amber/[0.06] p-3">
							<div className="flex items-start gap-2.5">
								<Icon
									icon={tablerArchive}
									width="17"
									height="17"
									className="mt-0.5 shrink-0 text-nova-amber"
								/>
								<div className="min-w-0">
									<p className="text-sm font-semibold text-nova-text">
										{heldCases === 1
											? "1 case held for review"
											: `${heldCases} cases held for review`}
									</p>
									<p className="mt-0.5 text-[13px] leading-relaxed text-nova-text-secondary">
										Out of the app until their values are decided
									</p>
								</div>
							</div>
							<Button
								type="button"
								variant="outline"
								className="mt-2.5 min-h-11 w-full"
								onClick={() => {
									setPopoverOpen(false);
									// The review screen is an edit surface — in preview the
									// data-review URL renders the running case list, so the
									// press would look like a no-op. Leave preview first.
									setPreviewing(false);
									navigate.openDataReview(moduleUuid);
								}}
							>
								<Icon icon={tablerArchive} width="15" height="15" />
								Review data
							</Button>
						</div>
					)}

					<div className="border-t border-nova-border px-4 pb-4 pt-4">
						<p className="sr-only" aria-live="polite" aria-atomic="true">
							{fetching && count !== undefined
								? `Refreshing case count… ${caseLabel(count)} ${count === 1 ? "is" : "are"} currently available.`
								: countState.kind === "count"
									? `${caseLabel(countState.count)} available`
									: countState.kind === "loading"
										? "Loading case data…"
										: "Case data isn't available"}
						</p>
						{countState.kind === "count" ? (
							<div>
								<div className="flex items-center gap-3">
									<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-nova-violet/[0.09] text-nova-violet-bright">
										<Icon icon={tablerDatabase} width="18" height="18" />
									</span>
									<div className="min-w-0">
										<p className="flex items-baseline gap-1.5 leading-none">
											<span className="text-2xl font-semibold text-nova-text">
												{countState.count.toLocaleString()}
											</span>{" "}
											<span className="text-sm font-medium text-nova-text-secondary">
												{countState.count === 1 ? "case" : "cases"}
											</span>
										</p>
									</div>
								</div>
								<p className="mt-3 text-sm leading-relaxed text-nova-text-secondary">
									{countState.count === 0
										? canEdit
											? "Add sample cases to try Search, Results, and Details"
											: "No case data is available for Search, Results, or Details"
										: "Your Search and Results settings may show fewer cases than this total"}
								</p>
								{canEdit ? (
									countState.count === 0 ? (
										<Button
											type="button"
											variant="outline"
											className="mt-4 min-h-11 w-full"
											disabled={loading}
											onClick={() => void createSamples()}
										>
											<Icon
												icon={
													operation === "create"
														? tablerLoader2
														: tablerSparkles
												}
												className={
													operation === "create" ? "animate-spin" : undefined
												}
											/>
											{operation === "create"
												? "Adding sample cases"
												: "Add sample cases"}
										</Button>
									) : (
										<Button
											type="button"
											variant="destructive"
											className="mt-4 min-h-11 w-full"
											disabled={loading}
											onClick={() => {
												setError(null);
												setPopoverOpen(false);
												setConfirmOpen(true);
											}}
										>
											<Icon icon={tablerRefresh} />
											Replace case data
										</Button>
									)
								) : (
									<p className="mt-4 rounded-lg bg-nova-elevated px-3 py-2.5 text-sm leading-relaxed text-nova-text-secondary">
										You can view case data, but you can’t add or replace it
									</p>
								)}
							</div>
						) : countState.kind === "error" ? (
							<div
								role="alert"
								className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3"
							>
								<p className="font-medium text-nova-text">
									Case data didn’t load
								</p>
								<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
									Try again to view case data
								</p>
								<Button
									type="button"
									variant="outline"
									className="mt-3 min-h-11"
									onClick={() => void retryCount()}
								>
									<Icon icon={tablerRefresh} />
									Try again
								</Button>
							</div>
						) : countState.kind === "unauthenticated" ? (
							<div className="rounded-lg border border-nova-border bg-nova-elevated p-3">
								<p className="font-medium text-nova-text">You’re signed out</p>
								<p className="mt-1 text-sm leading-relaxed text-nova-text-secondary">
									Reload the page to sign in again and view case data
								</p>
								<Button
									type="button"
									variant="outline"
									className="mt-3 min-h-11"
									onClick={() => window.location.reload()}
								>
									<Icon icon={tablerRefresh} />
									Reload
								</Button>
							</div>
						) : (
							<p className="flex min-h-16 items-center gap-2 text-sm text-nova-text-secondary">
								<Icon icon={tablerLoader2} className="animate-spin" />
								Loading case data…
							</p>
						)}

						{error && (
							<p
								role="alert"
								className="mt-3 rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3 text-sm leading-relaxed text-nova-rose"
							>
								{error}
							</p>
						)}
					</div>
				</PopoverContent>
			</Popover>

			<AlertDialog
				open={confirmOpen && accessPhase === "authorized"}
				onOpenChange={(nextOpen, eventDetails) => {
					if (accessPhase !== "authorized") {
						setConfirmOpen(false);
						return;
					}
					// AlertDialog already blocks outside presses, but Escape remains a
					// valid Base UI close reason. Once replacement starts, keep the
					// confirmation mounted until its success or failure is visible.
					if (!nextOpen && loading) {
						// Cancelling the Base UI event is distinct from merely retaining the
						// controlled `open` prop: it also prevents close-time focus restoration
						// from moving focus behind this still-mounted modal.
						eventDetails.cancel();
						refocusPendingSurface(confirmTitleRef.current);
						return;
					}
					setConfirmOpen(nextOpen);
					if (!nextOpen) restoreTriggerFocus();
				}}
			>
				<AlertDialogContent
					ref={pendingConfirmContentRef}
					className="text-left"
					aria-busy={loading}
				>
					<AlertDialogHeader>
						<AlertDialogTitle
							ref={confirmTitleRef}
							tabIndex={operation === "replace" ? 0 : -1}
							className="font-display outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-nova-violet-bright/75 focus-visible:ring-offset-2 focus-visible:ring-offset-nova-deep"
						>
							Replace all {caseLabel(count ?? 0)}?
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left text-pretty">
							All “{caseTypeDisplayName}” cases will be replaced throughout the
							app, including cases added by hand or through Preview. New sample
							cases will appear everywhere this case type is used.
							{hasLinkedChildren && (
								<>
									{" "}
									Linked cases will stay, but they’ll lose their links to the
									cases you’re replacing.
								</>
							)}{" "}
							You can't undo this.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{operation === "replace" && (
						<p
							role="status"
							aria-live="polite"
							aria-atomic="true"
							className="sr-only"
						>
							Replacing case data…
						</p>
					)}
					{error && (
						<p
							role="alert"
							className="rounded-lg border border-nova-rose/30 bg-nova-rose/[0.06] p-3 text-sm leading-relaxed text-nova-rose"
						>
							{error}
						</p>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={loading}
							onClick={() => void replaceSamples()}
						>
							{operation === "replace" && (
								<Icon icon={tablerLoader2} className="animate-spin" />
							)}
							{operation === "replace" ? "Replacing" : "Replace"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
