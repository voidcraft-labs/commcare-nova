/**
 * Builder-owned case-data controls. This lives in the breadcrumb strip rather
 * than inside the simulated app: Preview stays faithful to what a frontline
 * user sees, while the builder keeps one predictable place to create or
 * replace the real case rows used for testing.
 */
"use client";

import { Icon } from "@iconify/react/offline";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import tablerSparkles from "@iconify-icons/tabler/sparkles";
import { useState } from "react";
import { describePopulateError } from "@/components/preview/shared/sampleData";
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
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { type CaseType, humanizeId } from "@/lib/domain";
import {
	useCaseCount,
	usePopulateSampleCases,
	useResetSampleCases,
} from "@/lib/preview/hooks/useCaseDataBinding";
import { showToast } from "@/lib/ui/toastStore";

type Operation = "create" | "replace" | null;

function caseLabel(count: number): string {
	return `${count.toLocaleString()} ${count === 1 ? "case" : "cases"}`;
}

/** Person-facing case wording for a domain name without exposing the stored
 * identifier or producing awkward phrases such as "Patient case cases". */
function caseTypeLabel(caseTypeName: string, plural: boolean): string {
	const displayName = humanizeId(caseTypeName) || "Case";
	const singular = /\bcase$/i.test(displayName)
		? displayName
		: `${displayName} case`;
	return plural ? `${singular}s` : singular;
}

function typedCaseLabel(count: number, caseTypeName: string): string {
	return `${count.toLocaleString()} ${caseTypeLabel(caseTypeName, count !== 1)}`;
}

export function CaseDataManager({
	appId,
	caseType,
	canEdit,
	hasLinkedChildren,
}: {
	readonly appId: string;
	readonly caseType: CaseType;
	readonly canEdit: boolean;
	readonly hasLinkedChildren: boolean;
}) {
	const { state: countState, fetching } = useCaseCount({
		appId,
		caseType: caseType.name,
	});
	const populate = usePopulateSampleCases({ appId, caseType });
	const reset = useResetSampleCases({ appId, caseType });
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [operation, setOperation] = useState<Operation>(null);
	const [error, setError] = useState<string | null>(null);

	const count = countState.kind === "count" ? countState.count : undefined;
	const caseTypeDisplayName = humanizeId(caseType.name) || "Case";
	const caseTypeCases = caseTypeLabel(caseType.name, true);
	const triggerSummary =
		count !== undefined
			? caseLabel(count)
			: countState.kind === "error" || countState.kind === "unauthenticated"
				? "Unavailable"
				: "Loading…";
	const triggerLabel = `Case data for ${caseTypeDisplayName}, ${triggerSummary}${fetching && count !== undefined ? ", refreshing" : ""}, shared across this app`;

	const createSamples = async () => {
		setOperation("create");
		setError(null);
		try {
			const result = await populate();
			if (result.kind !== "ok") {
				setError(describePopulateError(result, "Generate"));
				return;
			}
			setPopoverOpen(false);
			showToast(
				"info",
				"Sample cases created",
				`${caseLabel(result.inserted)} are ready to use in Preview.`,
			);
		} catch {
			setError("Could not create sample cases. Try again.");
		} finally {
			setOperation(null);
		}
	};

	const replaceSamples = async () => {
		setOperation("replace");
		setError(null);
		try {
			const result = await reset();
			if (result.kind !== "ok") {
				setError(describePopulateError(result, "Reset"));
				return;
			}
			setConfirmOpen(false);
			showToast(
				"info",
				"Case data replaced",
				`${caseLabel(result.inserted)} are ready to use in Preview.`,
			);
		} catch {
			setError("Could not replace these cases. Try again.");
		} finally {
			setOperation(null);
		}
	};

	const loading = operation !== null;

	return (
		<>
			<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
				<PopoverTrigger
					aria-label={triggerLabel}
					className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-nova-border bg-nova-surface/70 px-2.5 text-sm text-nova-text-secondary transition-colors hover:border-nova-violet/45 hover:bg-nova-elevated hover:text-nova-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nova-violet-bright/60 xl:px-3"
				>
					<Icon icon={tablerDatabase} width="16" height="16" />
					<span className="hidden items-center gap-2 xl:inline-flex">
						<span>Case data</span>
						<span className="text-nova-text-muted" aria-hidden="true">
							·
						</span>
					</span>
					<span className="text-nova-text">{triggerSummary}</span>
					{fetching && count !== undefined && (
						<Icon
							icon={tablerLoader2}
							width="14"
							height="14"
							className="animate-spin text-nova-text-muted"
							aria-label="Refreshing case count"
						/>
					)}
				</PopoverTrigger>
				<PopoverContent
					align="end"
					sideOffset={8}
					className="max-h-[calc(var(--available-height)-0.5rem)] w-80 max-w-[calc(var(--available-width)-0.5rem)] gap-0 overflow-x-hidden overflow-y-auto p-0"
				>
					<PopoverHeader className="gap-1 px-4 pb-3 pt-4">
						<PopoverTitle className="font-display text-base font-semibold text-nova-text">
							Case data
						</PopoverTitle>
						<PopoverDescription className="text-xs leading-relaxed text-nova-text-secondary">
							All {caseTypeCases} in this app. Every module that works with{" "}
							{caseTypeCases} shares this data in Preview.
						</PopoverDescription>
					</PopoverHeader>

					<div className="border-t border-white/[0.07] px-4 pb-4 pt-3.5">
						<p className="sr-only" aria-live="polite" aria-atomic="true">
							{fetching && count !== undefined
								? `Refreshing. ${caseLabel(count)} currently available.`
								: countState.kind === "count"
									? `${caseLabel(countState.count)} available.`
									: countState.kind === "loading"
										? "Loading case data."
										: "Case data is unavailable."}
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
											<span className="text-xs font-medium text-nova-text-secondary">
												{countState.count === 1 ? "case" : "cases"}
											</span>
										</p>
									</div>
								</div>
								<p className="mt-3 text-xs leading-relaxed text-nova-text-muted">
									{countState.count === 0
										? "No cases yet. Add a realistic set to try the complete Search, Results, and Details flow."
										: "This is the complete set, before search rules are applied."}
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
												? "Adding sample cases…"
												: "Add sample cases"}
										</Button>
									) : (
										<Button
											type="button"
											variant="outline"
											className="mt-4 min-h-11 w-full"
											disabled={loading}
											onClick={() => {
												setError(null);
												setPopoverOpen(false);
												setConfirmOpen(true);
											}}
										>
											<Icon icon={tablerRefresh} />
											Replace all{" "}
											{typedCaseLabel(countState.count, caseType.name)}…
										</Button>
									)
								) : (
									<p className="mt-4 rounded-lg bg-white/[0.04] px-3 py-2.5 text-xs leading-relaxed text-nova-text-muted">
										Only editors can create or replace case data.
									</p>
								)}
							</div>
						) : countState.kind === "error" ? (
							<p className="text-xs leading-relaxed text-nova-rose">
								{countState.message}
							</p>
						) : countState.kind === "unauthenticated" ? (
							<p className="text-xs leading-relaxed text-nova-text-secondary">
								Sign in again to view case data.
							</p>
						) : (
							<p className="flex min-h-16 items-center gap-2 text-sm text-nova-text-secondary">
								<Icon icon={tablerLoader2} className="animate-spin" />
								Loading case data…
							</p>
						)}

						{error && (
							<p
								role="alert"
								className="mt-3 whitespace-pre-line text-xs leading-relaxed text-nova-rose"
							>
								{error}
							</p>
						)}
					</div>
				</PopoverContent>
			</Popover>

			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogContent className="text-left">
					<AlertDialogHeader>
						<AlertDialogTitle className="font-display">
							Replace all {typedCaseLabel(count ?? 0, caseType.name)}?
						</AlertDialogTitle>
						<AlertDialogDescription className="text-left text-pretty">
							This deletes all {caseTypeCases} in this app—including cases
							entered by hand or through Preview—and replaces them with a new
							sample set. Every module that works with {caseTypeCases} will see
							the replacement.
							{hasLinkedChildren && (
								<>
									{" "}
									Cases elsewhere in this app that are linked to these cases
									will be kept, but those links will be cleared.
								</>
							)}{" "}
							This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{error && (
						<p
							role="alert"
							className="whitespace-pre-line text-xs leading-relaxed text-nova-rose"
						>
							{error}
						</p>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel size="xl" disabled={loading}>
							Keep current cases
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							size="xl"
							disabled={loading}
							onClick={() => void replaceSamples()}
						>
							{operation === "replace" && (
								<Icon icon={tablerLoader2} className="animate-spin" />
							)}
							{operation === "replace"
								? "Replacing cases…"
								: `Replace ${typedCaseLabel(count ?? 0, caseType.name)}`}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
